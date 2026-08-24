import type { Metadata } from 'next';
import Link from 'next/link';
import { BarChart3 } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Términos de Servicio | AdsHouse Reporting',
  description:
    'Términos de Servicio de AdsHouse Reporting: condiciones de uso de la plataforma de reportería publicitaria.',
};

const LAST_UPDATED = '4 de junio de 2026';
const CONTACT_EMAIL = 'adminrinconpentecostal@gmail.com';

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {/* Brand ambient glows */}
      <div className="absolute top-[-15%] left-[-10%] w-[45%] h-[45%] ambient-glow-red" />
      <div className="absolute bottom-[-15%] right-[-10%] w-[45%] h-[45%] ambient-glow-blue" />

      <div className="relative mx-auto max-w-3xl px-6 py-16">
        {/* Header / brand mark */}
        <Link href="/" className="flex items-center gap-3 mb-12 w-fit group">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl shadow-lg brand-gradient-reporting">
            <BarChart3 className="h-5 w-5 text-white" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-xl font-bold tracking-tight text-foreground">AdsHouse</span>
            <span className="text-[10px] font-medium text-muted-foreground/70 tracking-widest uppercase">
              Reporting
            </span>
          </div>
        </Link>

        <article className="space-y-8">
          <header className="space-y-2 border-b border-border pb-8">
            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              Términos de Servicio
            </h1>
            <p className="text-sm text-muted-foreground">Última actualización: {LAST_UPDATED}</p>
          </header>

          <Section title="1. Aceptación de los términos">
            <p>
              Estos Términos de Servicio («Términos») regulan el acceso y uso de AdsHouse Reporting
              («la Plataforma», «el Servicio», «nosotros»), una herramienta de generación de
              reportes que consolida métricas de campañas publicitarias de plataformas de terceros
              como Meta (Facebook e Instagram), TikTok y Hotmart.
            </p>
            <p>
              Al acceder o utilizar la Plataforma, aceptas quedar vinculado por estos Términos. Si
              no estás de acuerdo con ellos, no debes utilizar el Servicio.
            </p>
          </Section>

          <Section title="2. Descripción del servicio">
            <p>
              La Plataforma permite a los usuarios conectar sus cuentas publicitarias mediante
              autorización OAuth y visualizar, en paneles y reportes, las métricas de rendimiento de
              sus campañas obtenidas a través de las API oficiales de cada proveedor. El acceso a
              los datos publicitarios se realiza en modo de solo lectura.
            </p>
          </Section>

          <Section title="3. Cuentas de usuario">
            <p>
              Para utilizar el Servicio debes crear una cuenta y proporcionar información veraz y
              actualizada. Eres responsable de mantener la confidencialidad de tus credenciales y de
              toda la actividad que ocurra bajo tu cuenta. Debes notificarnos de inmediato cualquier
              uso no autorizado.
            </p>
          </Section>

          <Section title="4. Conexiones con plataformas de terceros">
            <p>
              Al conectar una cuenta de Meta, TikTok u otra plataforma, nos autorizas a acceder a
              tus datos publicitarios con el único fin de generar tus reportes. Tu uso de dichas
              plataformas también está sujeto a sus respectivos términos y políticas. Puedes revocar
              el acceso en cualquier momento desde la configuración de tu cuenta de cada proveedor o
              desde los ajustes de la Plataforma.
            </p>
          </Section>

          <Section title="5. Uso aceptable">
            <p>Al utilizar la Plataforma, te comprometes a no:</p>
            <ul>
              <li>Utilizar el Servicio para fines ilícitos o no autorizados.</li>
              <li>
                Intentar acceder a datos, cuentas o sistemas a los que no tienes autorización.
              </li>
              <li>
                Interferir con el funcionamiento del Servicio, introducir software malicioso o
                sobrecargar la infraestructura.
              </li>
              <li>
                Revender, redistribuir o explotar el Servicio sin nuestro consentimiento previo por
                escrito.
              </li>
            </ul>
          </Section>

          <Section title="6. Propiedad intelectual">
            <p>
              La Plataforma, su código, diseño, marcas y contenidos son propiedad de AdsHouse
              Reporting o de sus licenciantes y están protegidos por las leyes aplicables. Estos
              Términos no te otorgan ningún derecho de propiedad sobre el Servicio. Los datos
              publicitarios obtenidos de tus cuentas siguen siendo tuyos.
            </p>
          </Section>

          <Section title="7. Privacidad">
            <p>
              El tratamiento de tus datos personales y publicitarios se rige por nuestra{' '}
              <Link href="/privacy">Política de Privacidad</Link>, que forma parte integral de estos
              Términos.
            </p>
          </Section>

          <Section title="8. Disponibilidad del servicio">
            <p>
              Nos esforzamos por mantener el Servicio disponible, pero no garantizamos un
              funcionamiento ininterrumpido o libre de errores. Podemos modificar, suspender o
              descontinuar el Servicio, total o parcialmente, en cualquier momento. La exactitud de
              las métricas mostradas depende de los datos proporcionados por las API de terceros.
            </p>
          </Section>

          <Section title="9. Limitación de responsabilidad">
            <p>
              El Servicio se proporciona «tal cual» y «según disponibilidad», sin garantías de
              ningún tipo. En la máxima medida permitida por la ley, no seremos responsables por
              daños indirectos, incidentales o consecuentes derivados del uso o la imposibilidad de
              uso de la Plataforma, ni por decisiones tomadas con base en los reportes generados.
            </p>
          </Section>

          <Section title="10. Terminación">
            <p>
              Puedes dejar de usar el Servicio y eliminar tu cuenta en cualquier momento. Podemos
              suspender o cancelar tu acceso si incumples estos Términos. Tras la terminación,
              eliminaremos los tokens de acceso asociados y los datos derivados conforme a nuestra
              Política de Privacidad.
            </p>
          </Section>

          <Section title="11. Cambios en los términos">
            <p>
              Podemos actualizar estos Términos ocasionalmente. Publicaremos los cambios en esta
              página y actualizaremos la fecha de «Última actualización». El uso continuado del
              Servicio tras dichos cambios constituye tu aceptación de los mismos.
            </p>
          </Section>

          <Section title="12. Contacto">
            <p>
              Si tienes preguntas sobre estos Términos de Servicio, puedes escribirnos a{' '}
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
            </p>
          </Section>
        </article>

        <footer className="mt-16 pt-8 border-t border-border">
          <p className="text-sm text-muted-foreground/70">
            © {LAST_UPDATED.split(' ').pop()} AdsHouse Reporting. Todos los derechos reservados.
          </p>
        </footer>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      <div className="space-y-3 text-[15px] leading-relaxed text-muted-foreground [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-2 [&_strong]:text-foreground [&_a]:text-brand-blue dark:[&_a]:text-brand-blue-light [&_a]:underline [&_a]:underline-offset-4 hover:[&_a]:opacity-80">
        {children}
      </div>
    </section>
  );
}
