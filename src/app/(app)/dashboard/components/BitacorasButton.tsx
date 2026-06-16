'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BookOpen } from 'lucide-react'
import { BitacorasModule } from './BitacorasModule'

export function BitacorasButton({ clientId, userRole }: { clientId: string; userRole: string }) {
    const [open, setOpen] = useState(false)

    return (
        <>
            <button
                onClick={() => setOpen(true)}
                className="fixed bottom-6 right-6 z-40 flex items-center gap-2 bg-card border border-border shadow-lg rounded-full px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent transition-colors"
            >
                <BookOpen className="w-4 h-4" />
                Bitácoras
            </button>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
                    <DialogHeader className="shrink-0">
                        <DialogTitle className="flex items-center gap-2">
                            <BookOpen className="w-4 h-4" />
                            Bitácoras del cliente
                        </DialogTitle>
                    </DialogHeader>
                    <div className="overflow-y-auto flex-1 pr-1">
                        {open && <BitacorasModule clientId={clientId} userRole={userRole} />}
                    </div>
                </DialogContent>
            </Dialog>
        </>
    )
}
