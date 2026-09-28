/**
 * Genera las skills de uso de las herramientas de informes BI.
 *
 *   npm run skill:informes            → escribe las dos skills
 *   npm run skill:informes -- --zip   → además, skills/informes-bi-mcp.zip
 *
 * La fuente es `src/lib/agent/guias/informes.ts`; los archivos generados no se
 * editan a mano. `scripts/verify-skill-informes.ts` falla si se desincronizan.
 *
 * Salidas:
 *   .claude/skills/informes-bi/   — skill de Claude Code (se carga sola en este repo)
 *   skills/informes-bi-mcp/       — skill para claude.ai: comprime la CARPETA y súbela
 *                                   en Configuración → Capacidades → Skills.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DESTINOS_SKILL, renderSkill } from '../src/lib/agent/guias/informes';

const raiz = process.cwd();

for (const destino of DESTINOS_SKILL) {
  for (const { ruta, contenido } of renderSkill(destino)) {
    const destinoAbs = join(raiz, ruta);
    mkdirSync(dirname(destinoAbs), { recursive: true });
    writeFileSync(destinoAbs, contenido, 'utf8');
    console.log(`  ✓ ${ruta}`);
  }
}

if (process.argv.includes('--zip')) {
  const dir = join(raiz, 'skills');
  const zip = join(dir, 'informes-bi-mcp.zip');
  if (existsSync(zip)) rmSync(zip);
  // `tar -a` (bsdtar) elige el formato por la extensión. En Windows se usa el
  // del sistema: el `tar` de Git Bash es GNU y no sabe hacer zip. Rutas
  // relativas a `dir`, porque GNU/bsdtar leen «C:» como un host remoto. La
  // carpeta queda en la raíz del zip, que es lo que pide claude.ai.
  const sistema = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const tar = process.platform === 'win32' && existsSync(sistema) ? sistema : 'bsdtar';
  execFileSync(tar, ['-a', '-c', '-f', 'informes-bi-mcp.zip', 'informes-bi-mcp'], {
    cwd: dir,
    stdio: 'inherit',
  });
  console.log(`  ✓ skills/informes-bi-mcp.zip`);
}

console.log('\nSkills de informes generadas.');
