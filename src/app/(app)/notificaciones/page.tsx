import { createClient } from '@/utils/supabase/server';
import { IN_APP_NOTIFICATION_TYPES, type InAppNotificationType } from '@/lib/notifications/types';
import { getNotifications, getPreferences } from './_actions';
import { NotificacionesClient } from './NotificacionesClient';

export default async function NotificacionesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  const initialType = IN_APP_NOTIFICATION_TYPES.includes(type as InAppNotificationType)
    ? (type as InAppNotificationType)
    : undefined;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let userRole = 'viewer';
  if (user) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    if (profile?.role) userRole = profile.role;
  }

  const [{ items, total }, preferences] = await Promise.all([
    getNotifications({ page: 0, type: initialType }),
    getPreferences(),
  ]);

  return (
    <div className="space-y-6">
      <NotificacionesClient
        initialItems={items}
        initialTotal={total}
        initialPreferences={preferences}
        initialType={initialType}
        userRole={userRole}
      />
    </div>
  );
}
