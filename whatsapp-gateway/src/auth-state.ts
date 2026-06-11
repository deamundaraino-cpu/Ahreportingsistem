// Adaptador de AuthenticationState de Baileys respaldado en Supabase.
//
// Equivalente a useMultiFileAuthState pero guardando `creds` + `keys` en la
// tabla public.whatsapp_session (fila única 'agency'), para que la sesión
// sobreviva redeploys/reinicios sin volumen persistente.
//
// Serialización con BufferJSON (los Buffers viajan como base64 en JSONB).

import {
    initAuthCreds,
    BufferJSON,
    proto,
    type AuthenticationCreds,
    type AuthenticationState,
    type SignalDataTypeMap,
} from '@whiskeysockets/baileys'
import type { SupabaseClient } from '@supabase/supabase-js'

const SESSION_ID = 'agency'

type KeyStore = Record<string, Record<string, unknown>>

// Rehidrata cualquier estructura serializada con BufferJSON.
function revive<T>(value: unknown): T {
    return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T
}

// Prepara una estructura para guardar en JSONB (Buffers → base64).
function serialize<T>(value: T): unknown {
    return JSON.parse(JSON.stringify(value, BufferJSON.replacer))
}

export async function useSupabaseAuthState(db: SupabaseClient): Promise<{
    state: AuthenticationState
    saveCreds: () => Promise<void>
    clear: () => Promise<void>
}> {
    const { data: row } = await db
        .from('whatsapp_session')
        .select('creds, keys')
        .eq('id', SESSION_ID)
        .maybeSingle()

    const creds: AuthenticationCreds = row?.creds
        ? revive<AuthenticationCreds>(row.creds)
        : initAuthCreds()

    const keys: KeyStore = row?.keys ? revive<KeyStore>(row.keys) : {}

    async function persist(): Promise<void> {
        await db.from('whatsapp_session').upsert({
            id: SESSION_ID,
            creds: serialize(creds),
            keys: serialize(keys),
            updated_at: new Date().toISOString(),
        })
    }

    const state: AuthenticationState = {
        creds,
        keys: {
            get: async (type, ids) => {
                const store = keys[type] ?? {}
                const result: Record<string, SignalDataTypeMap[typeof type]> = {}
                for (const id of ids) {
                    let value = store[id]
                    if (value && type === 'app-state-sync-key') {
                        value = proto.Message.AppStateSyncKeyData.fromObject(
                            value as Record<string, unknown>,
                        )
                    }
                    if (value !== undefined) {
                        result[id] = value as SignalDataTypeMap[typeof type]
                    }
                }
                return result
            },
            set: async (data) => {
                for (const type of Object.keys(data) as (keyof typeof data)[]) {
                    keys[type] = keys[type] ?? {}
                    const entries = data[type]!
                    for (const id of Object.keys(entries)) {
                        const value = entries[id]
                        if (value) {
                            keys[type][id] = value as Record<string, unknown>
                        } else {
                            delete keys[type][id]
                        }
                    }
                }
                await persist()
            },
        },
    }

    return {
        state,
        saveCreds: persist,
        clear: async () => {
            await db.from('whatsapp_session').delete().eq('id', SESSION_ID)
        },
    }
}
