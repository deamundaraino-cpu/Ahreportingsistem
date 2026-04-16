export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    // Return children directly as all authenticated users can access admin panel now
    return <>{children}</>
}
