/**
 * Reglas del canal de WhatsApp.
 *
 * Lo que se fija aquí es la lógica que decide si el agente responde y a quién
 * reconoce. Un fallo en esta capa no rompe nada de forma visible: simplemente
 * el bot contesta a quien no debía, o ignora a quien sí.
 *
 * Sin base de datos: forma parte de `test:puro`.
 */
import { evaluarActivacion, parsearComando, PREFIJOS } from '../src/lib/agent/whatsapp/identidad';

let ok = 0,
  fail = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    ok++;
    console.log('  ✓ ' + nombre);
  } else {
    fail++;
    console.log('  ✗ ' + nombre + (detalle ? '  → ' + detalle : ''));
  }
}

const BOT = '573001112233:12@s.whatsapp.net';

console.log('\n── Chat privado ─────────────────────────────────────────────');

const priv = evaluarActivacion({
  esGrupo: false,
  texto: '¿cómo va Goodprop?',
  requiereMencion: true,
  mentions: [],
  jidBot: BOT,
});
check('en privado responde sin prefijo', priv.activado);
check('en privado el texto llega intacto', priv.texto === '¿cómo va Goodprop?');

console.log('\n── Grupo: hace falta que lo llamen ──────────────────────────');

// Sin esto el bot leería y pagaría por cada mensaje del grupo.
const suelto = evaluarActivacion({
  esGrupo: true,
  texto: 'oye, ¿alguien vio el partido?',
  requiereMencion: true,
  mentions: [],
  jidBot: BOT,
});
check('un mensaje cualquiera del grupo NO lo activa', !suelto.activado);

for (const p of PREFIJOS) {
  const r = evaluarActivacion({
    esGrupo: true,
    texto: `${p} cómo va Goodprop`,
    requiereMencion: true,
    mentions: [],
    jidBot: BOT,
  });
  check(`el prefijo "${p}" lo activa`, r.activado, r.motivo);
  check(`el prefijo "${p}" se quita del texto`, r.texto === 'cómo va Goodprop', r.texto);
}

const mayus = evaluarActivacion({
  esGrupo: true,
  texto: '/AH dame el resumen',
  requiereMencion: true,
  mentions: [],
  jidBot: BOT,
});
check('el prefijo no distingue mayúsculas', mayus.activado);

// El jid completo trae sufijo de dispositivo (:12), que no siempre coincide.
const mencion = evaluarActivacion({
  esGrupo: true,
  texto: '@agente cómo va todo',
  requiereMencion: true,
  mentions: ['573001112233@s.whatsapp.net'],
  jidBot: BOT,
});
check('una mención al bot lo activa aunque el sufijo de dispositivo no coincida', mencion.activado);

const otraMencion = evaluarActivacion({
  esGrupo: true,
  texto: '@juan mira esto',
  requiereMencion: true,
  mentions: ['573009998877@s.whatsapp.net'],
  jidBot: BOT,
});
check('mencionar a otra persona NO lo activa', !otraMencion.activado);

const sinMencionObligatoria = evaluarActivacion({
  esGrupo: true,
  texto: 'cualquier cosa',
  requiereMencion: false,
  mentions: [],
  jidBot: BOT,
});
check('un canal sin mención obligatoria responde a todo', sinMencionObligatoria.activado);

const sinBot = evaluarActivacion({
  esGrupo: true,
  texto: 'hola',
  requiereMencion: true,
  mentions: ['573001112233@s.whatsapp.net'],
  jidBot: null,
});
check('sin conocer el jid del bot no se activa por mención', !sinBot.activado);

console.log('\n── Comandos de aprobación ───────────────────────────────────');

// Se atienden como comando y no como conversación: son una decisión, y no tiene
// sentido gastar una llamada al modelo ni arriesgarse a que la interprete mal.
const aprobar = parsearComando('APROBAR 4258e5f4-c7ba-4004-923f-fb9eae994bf8');
check('reconoce APROBAR', aprobar?.tipo === 'aprobar');
check('extrae el identificador', aprobar?.numero === '4258e5f4-c7ba-4004-923f-fb9eae994bf8');

check('reconoce RECHAZAR', parsearComando('rechazar 4258e5f4')?.tipo === 'rechazar');
check('acepta la almohadilla', parsearComando('aprobar #4258e5f4')?.numero === '4258e5f4');
check('no distingue mayúsculas', parsearComando('Aprobar 4258e5f4')?.tipo === 'aprobar');
check('tolera espacios alrededor', parsearComando('  aprobar 4258e5f4  ')?.tipo === 'aprobar');

check('una frase normal no es un comando', parsearComando('¿puedes aprobar el informe?') === null);
check('aprobar sin identificador no es un comando', parsearComando('aprobar') === null);
check('un identificador demasiado corto no cuela', parsearComando('aprobar 12') === null);
check('texto libre no es un comando', parsearComando('cómo va Goodprop') === null);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} comprobaciones pasadas, ${fail} fallidas\n`);
process.exit(fail === 0 ? 0 : 1);
