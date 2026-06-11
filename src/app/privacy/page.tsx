import type { Metadata } from 'next'
import Link from 'next/link'
import { BarChart3 } from 'lucide-react'

export const metadata: Metadata = {
    title: 'Política de Privacidad | AdsHouse Reporting',
    description:
        'Política de privacidad de AdsHouse Reporting: cómo recopilamos, usamos y protegemos los datos de las plataformas de publicidad conectadas.',
}

const LAST_UPDATED = '4 de junio de 2026'
const CONTACT_EMAIL = 'adminrinconpentecostal@gmail.com'

export default function PrivacyPolicyPage() {
    return (
        <div className="min-h-screen bg-background relative overflow-hidden">
            {/* Brand ambient glows */}
            <div
                className="absolute top-[-15%] left-[-10%] w-[45%] h-[45%] ambient-glow-red"
            />
            <div
                className="absolute bottom-[-15%] right-[-10%] w-[45%] h-[45%] ambient-glow-blue"
            />

            <div className="relative mx-auto max-w-3xl px-6 py-16">
                {/* Header / brand mark */}
                <Link href="/" className="flex items-center gap-3 mb-12 w-fit group">
                    <div
                        className="flex h-11 w-11 items-center justify-center rounded-xl shadow-lg brand-gradient-reporting"
                    >
                        <BarChart3 className="h-5 w-5 text-white" />
                    </div>
                    <div className="flex flex-col leading-tight">
                        <span className="text-xl font-bold tracking-tight text-foreground">
                            AdsHouse
                        </span>
                        <span className="text-[10px] font-medium text-muted-foreground/70 tracking-widest uppercase">
                            Reporting
                        </span>
                    </div>
                </Link>

                <article className="prose-custom space-y-8">
                    <header className="space-y-2 border-b border-border pb-8">
                        <h1 className="text-3xl font-bold tracking-tight text-foreground">
                            Política de Privacidad
                        </h1>
                        <p className="text-sm text-muted-foreground">
                            Última actualización: {LAST_UPDATED}
                        </p>
                    </header>

                    <Section title="1. Introducción">
                        <p>
                            AdsHouse Reporting («la Plataforma», «nosotros») es una herramienta de generación de
                            reportes publicitarios que consolida métricas de campañas provenientes de plataformas
                            de terceros como Meta (Facebook e Instagram), TikTok y Hotmart. Esta Política de
                            Privacidad describe qué información recopilamos, cómo la utilizamos, con quién la
                            compartimos y los derechos que tienes sobre ella.
                        </p>
                        <p>
                            Al utilizar la Plataforma o conectar tus cuentas publicitarias, aceptas las prácticas
                            descritas en esta política.
                        </p>
                    </Section>

                    <Section title="2. Información que recopilamos">
                        <p>Recopilamos las siguientes categorías de información:</p>
                        <ul>
                            <li>
                                <strong>Información de cuenta:</strong> nombre, dirección de correo electrónico y
                                credenciales de acceso necesarias para autenticarte en la Plataforma.
                            </li>
                            <li>
                                <strong>Tokens de acceso de terceros:</strong> cuando conectas una cuenta de Meta,
                                TikTok u otra plataforma mediante OAuth, almacenamos de forma segura los tokens de
                                acceso que nos permiten leer tus datos publicitarios en tu nombre.
                            </li>
                            <li>
                                <strong>Datos publicitarios:</strong> métricas e información de rendimiento de tus
                                campañas, conjuntos de anuncios y anuncios, tales como inversión, impresiones,
                                clics, alcance, conversiones y resultados, obtenidos a través de las API oficiales
                                de las plataformas conectadas.
                            </li>
                            <li>
                                <strong>Datos de uso:</strong> información técnica sobre cómo interactúas con la
                                Plataforma, como registros de acceso, dirección IP y tipo de navegador.
                            </li>
                        </ul>
                        <p>
                            No recopilamos ni almacenamos las contraseñas de tus cuentas de Meta, TikTok u otras
                            plataformas de terceros. La autenticación se realiza directamente a través de los
                            sistemas seguros de cada proveedor.
                        </p>
                    </Section>

                    <Section title="3. Cómo utilizamos la información">
                        <p>Utilizamos la información recopilada únicamente para los siguientes fines:</p>
                        <ul>
                            <li>Proporcionar, mantener y mejorar los servicios de reportería de la Plataforma.</li>
                            <li>
                                Obtener y mostrar las métricas de rendimiento de tus campañas publicitarias en
                                paneles y reportes.
                            </li>
                            <li>Autenticar tu acceso y proteger la seguridad de tu cuenta.</li>
                            <li>Comunicarnos contigo sobre el funcionamiento del servicio.</li>
                        </ul>
                        <p>
                            No vendemos, alquilamos ni utilizamos tus datos publicitarios con fines distintos a la
                            prestación del servicio de reportería que has solicitado.
                        </p>
                    </Section>

                    <Section title="4. Datos de Meta y TikTok">
                        <p>
                            El uso que hacemos de la información obtenida a través de las API de Meta y TikTok se
                            ajusta a las políticas de plataforma de dichos proveedores, incluyendo la{' '}
                            <a
                                href="https://developers.facebook.com/terms/"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                Política de la Plataforma de Meta
                            </a>{' '}
                            y los{' '}
                            <a
                                href="https://developers.tiktok.com/doc/tiktok-api-terms-of-service"
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                Términos de Servicio de TikTok para Desarrolladores
                            </a>
                            .
                        </p>
                        <p>
                            Accedemos a tus datos publicitarios en modo de solo lectura, con el único propósito de
                            generar reportes para ti. Puedes revocar nuestro acceso en cualquier momento desde la
                            configuración de tu cuenta de Meta o TikTok, o desde la sección de ajustes de la
                            Plataforma.
                        </p>
                    </Section>

                    <Section title="5. Almacenamiento y seguridad">
                        <p>
                            Tus datos se almacenan en infraestructura segura proporcionada por nuestros proveedores
                            de servicios (Supabase y Vercel). Aplicamos medidas técnicas y organizativas razonables
                            para proteger la información contra el acceso no autorizado, la pérdida o la
                            divulgación, incluyendo el cifrado en tránsito y el almacenamiento protegido de los
                            tokens de acceso.
                        </p>
                    </Section>

                    <Section title="6. Conservación de los datos">
                        <p>
                            Conservamos tu información mientras tu cuenta permanezca activa o mientras sea necesaria
                            para prestarte el servicio. Cuando eliminas una conexión o tu cuenta, eliminamos los
                            tokens de acceso asociados y los datos publicitarios derivados dentro de un plazo
                            razonable.
                        </p>
                    </Section>

                    <Section title="7. Compartición con terceros">
                        <p>
                            No compartimos tu información personal ni tus datos publicitarios con terceros, salvo
                            en los siguientes casos:
                        </p>
                        <ul>
                            <li>
                                <strong>Proveedores de servicios:</strong> que nos ayudan a operar la Plataforma
                                (alojamiento, base de datos), bajo obligaciones de confidencialidad.
                            </li>
                            <li>
                                <strong>Obligaciones legales:</strong> cuando la ley lo exija o para proteger
                                nuestros derechos.
                            </li>
                        </ul>
                    </Section>

                    <Section title="8. Tus derechos">
                        <p>
                            Puedes solicitar el acceso, la corrección o la eliminación de tus datos personales, así
                            como revocar las conexiones con plataformas de terceros en cualquier momento. Para
                            ejercer estos derechos, contáctanos en la dirección indicada más abajo.
                        </p>
                    </Section>

                    <Section title="9. Cambios en esta política">
                        <p>
                            Podemos actualizar esta Política de Privacidad ocasionalmente. Publicaremos cualquier
                            cambio en esta página y actualizaremos la fecha de «Última actualización».
                        </p>
                    </Section>

                    <Section title="10. Contacto">
                        <p>
                            Si tienes preguntas sobre esta Política de Privacidad o sobre el tratamiento de tus
                            datos, puedes escribirnos a{' '}
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
    )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="space-y-3">
            <h2 className="text-xl font-semibold text-foreground">{title}</h2>
            <div className="space-y-3 text-[15px] leading-relaxed text-muted-foreground [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-2 [&_strong]:text-foreground [&_a]:text-brand-blue dark:[&_a]:text-brand-blue-light [&_a]:underline [&_a]:underline-offset-4 hover:[&_a]:opacity-80">
                {children}
            </div>
        </section>
    )
}
