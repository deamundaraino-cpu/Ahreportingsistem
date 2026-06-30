'use client';

import { useState, useMemo } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiTokensManager } from '@/components/api-tokens/ApiTokensManager';
import { toast } from 'sonner';
import {
  BellRing,
  Zap,
  Plus,
  Trash2,
  Edit2,
  Play,
  CheckCircle2,
  XCircle,
  HelpCircle,
  AlertTriangle,
  RotateCcw,
  VolumeX,
  MessageCircle,
  Users,
  Palette,
  Upload,
  Loader2,
} from 'lucide-react';
import { WhatsAppConfigClient } from '../../whatsapp/components/WhatsAppConfigClient';
import { UserManagementClient } from '../../users/UserManagementClient';
import { createClient } from '@/utils/supabase/client';
import {
  createNotificationRule,
  updateNotificationRule,
  deleteNotificationRule,
  testRule,
  triggerRulesEvaluation,
  updateBrandingSettings,
} from '../_actions';
import { type RuleRow } from '@/lib/notifications/rules-engine';

interface Props {
  initialRules: RuleRow[];
  clientes: { id: string; nombre: string }[];
  tabs: { id: string; nombre: string; cliente_id: string; keyword_meta?: string }[];
  baseUrl: string;
  waStatus: any;
  waGatewayError: string | null;
  waQr: string | null;
  waGroups: any[];
  waRoutes: any[];
  waClientes: any[];
  waMessages: any[];
  waAlertTeamGroup: { group_id: string | null; enabled: boolean };
  initialUsers: any[];
  allClients: any[];
  currentRole: string;
  currentUserId: string;
  initialBranding?: any;
}

const METRIC_LABELS: Record<string, string> = {
  budget_percentage: 'Porcentaje de Presupuesto (%)',
  roas: 'ROAS (retorno)',
  cpl: 'CPL (costo lead)',
  spend: 'Gasto Total ($)',
  revenue: 'Ingresos Totales ($)',
  leads: 'Leads Totales',
};

const WINDOW_LABELS: Record<string, string> = {
  today: 'Hoy',
  yesterday: 'Ayer',
  last_7_days: 'Últimos 7 días',
  last_30_days: 'Últimos 30 días',
  current_tab_period: 'Periodo de pestaña',
  custom_range: 'Rango personalizado',
};

// Custom Switch component to avoid shadcn switch dependency
function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-1 focus:ring-blue-500 focus:ring-offset-1 disabled:opacity-50 ${
        checked ? 'bg-blue-600' : 'bg-zinc-700'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

async function convertLogoToWebP(file: File, maxPx = 1024, quality = 0.9): Promise<File> {
  if (file.type === 'image/svg+xml' || file.name.endsWith('.svg')) {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    if (width > maxPx || height > maxPx) {
      const ratio = Math.min(maxPx / width, maxPx / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo obtener el contexto 2D del canvas');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Conversión WebP fallida'));
            return;
          }
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.webp'), { type: 'image/webp' }));
        },
        'image/webp',
        quality
      );
    });
  } catch (err) {
    console.warn('Fallo convertLogoToWebP, usando archivo original:', err);
    return file;
  }
}

export function ConfiguracionClient({
  initialRules,
  clientes,
  tabs,
  baseUrl,
  waStatus,
  waGatewayError,
  waQr,
  waGroups,
  waRoutes,
  waClientes,
  waMessages,
  waAlertTeamGroup,
  initialUsers,
  allClients,
  currentRole,
  currentUserId,
  initialBranding,
}: Props) {
  const [rules, setRules] = useState<RuleRow[]>(initialRules);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isTestOpen, setIsTestOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);

  // Branding states
  const [logoUrl, setLogoUrl] = useState<string>(initialBranding?.logo_url || '');
  const [primaryColor, setPrimaryColor] = useState<string>(initialBranding?.colors?.primary || '#1E6AB5');
  const [secondaryColor, setSecondaryColor] = useState<string>(initialBranding?.colors?.secondary || '#E53529');
  const [appName, setAppName] = useState<string>(initialBranding?.app_name || 'AdsHouse');
  const [appTag, setAppTag] = useState<string>(initialBranding?.app_tag || 'Reporting');
  const [utmName, setUtmName] = useState<string>(initialBranding?.utm_name || 'Report-UTM');
  const [utmTag, setUtmTag] = useState<string>(initialBranding?.utm_tag || 'Tracking & Atribución');
  const [uploadingLogo, setUploadingLogo] = useState<boolean>(false);
  const [savingBranding, setSavingBranding] = useState<boolean>(false);

  const PREDEFINED_THEMES = [
    { name: 'AdsHouse Original', primary: '#1E6AB5', secondary: '#E53529' },
    { name: 'Esmeralda Premium', primary: '#10B981', secondary: '#8B5CF6' },
    { name: 'Océano Profundo', primary: '#0A5F9E', secondary: '#0D9488' },
    { name: 'Púrpura Elegante', primary: '#7C3AED', secondary: '#DB2777' },
    { name: 'Ocaso Dorado', primary: '#D97706', secondary: '#DC2626' },
    { name: 'Negro Clásico', primary: '#1F2937', secondary: '#4B5563' },
  ];

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      toast.error('El archivo excede el tamaño máximo permitido de 2MB');
      return;
    }

    setUploadingLogo(true);
    try {
      const processedFile = await convertLogoToWebP(file);
      const supabase = createClient();
      const fileExt = processedFile.name.split('.').pop();
      const filePath = `branding/logo_${Date.now()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('bitacoras-images')
        .upload(filePath, processedFile, { contentType: processedFile.type, upsert: true });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('bitacoras-images')
        .getPublicUrl(filePath);

      setLogoUrl(publicUrl);
      toast.success('Logo subido e incorporado correctamente');
    } catch (err: any) {
      console.error('Error uploading logo:', err);
      toast.error('Error al subir logo: ' + (err.message || 'Error desconocido'));
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleSaveBranding = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingBranding(true);
    try {
      const payload = {
        logo_url: logoUrl.trim(),
        app_name: appName.trim(),
        app_tag: appTag.trim(),
        utm_name: utmName.trim(),
        utm_tag: utmTag.trim(),
        colors: {
          primary: primaryColor,
          secondary: secondaryColor,
        },
      };

      const res = await updateBrandingSettings(payload);
      if (res.error) throw new Error(res.error);
      
      toast.success('Personalización y Branding guardados. La página se actualizará.');
      // Refresh the page to reload variables
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (err: any) {
      toast.error(err.message || 'Error al guardar personalización');
    } finally {
      setSavingBranding(false);
    }
  };

  // Form states
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleName, setRuleName] = useState('');
  const [selectedCliente, setSelectedCliente] = useState<string>('global'); // 'global' or clientId
  const [selectedTab, setSelectedTab] = useState<string>('overall'); // 'overall' or tabId
  const [selectedMetric, setSelectedMetric] = useState<RuleRow['metric']>('budget_percentage');
  const [selectedOperator, setSelectedOperator] = useState<RuleRow['operator']>('>=');
  const [thresholdValue, setThresholdValue] = useState('');
  const [selectedWindow, setSelectedWindow] = useState<RuleRow['time_window']>('current_tab_period');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [channelInApp, setChannelInApp] = useState(true);
  const [channelWhatsApp, setChannelWhatsApp] = useState(false);
  const [cooldown, setCooldown] = useState('24');
  const [isEnabled, setIsEnabled] = useState(true);

  // Test state
  const [testResult, setTestResult] = useState<any>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  // Filter tabs for the selected client
  const filteredTabs = useMemo(() => {
    if (selectedCliente === 'global') return [];
    return tabs.filter((t) => t.cliente_id === selectedCliente);
  }, [selectedCliente, tabs]);

  const clientMap = useMemo(() => {
    return new Map(clientes.map((c) => [c.id, c.nombre]));
  }, [clientes]);

  const tabMap = useMemo(() => {
    return new Map(tabs.map((t) => [t.id, t.nombre]));
  }, [tabs]);

  const handleOpenNewDialog = () => {
    setEditingRuleId(null);
    setRuleName('');
    setSelectedCliente('global');
    setSelectedTab('overall');
    setSelectedMetric('budget_percentage');
    setSelectedOperator('>=');
    setThresholdValue('');
    setSelectedWindow('current_tab_period');
    setCustomStart('');
    setCustomEnd('');
    setChannelInApp(true);
    setChannelWhatsApp(false);
    setCooldown('24');
    setIsEnabled(true);
    setIsDialogOpen(true);
  };

  const handleOpenEditDialog = (rule: RuleRow) => {
    setEditingRuleId(rule.id);
    setRuleName(rule.nombre);
    setSelectedCliente(rule.cliente_id || 'global');
    setSelectedTab(rule.tab_id || 'overall');
    setSelectedMetric(rule.metric);
    setSelectedOperator(rule.operator);
    setThresholdValue(rule.value.toString());
    setSelectedWindow(rule.time_window);
    setCustomStart((rule as any).custom_start || '');
    setCustomEnd((rule as any).custom_end || '');
    setChannelInApp(rule.channels.includes('in_app'));
    setChannelWhatsApp(rule.channels.includes('whatsapp'));
    setCooldown(rule.cooldown_hours.toString());
    setIsEnabled(rule.enabled);
    setIsDialogOpen(true);
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ruleName.trim()) {
      toast.error('Escribe un nombre para la regla');
      return;
    }
    if (!thresholdValue.trim() || isNaN(Number(thresholdValue))) {
      toast.error('Ingresa un valor numérico válido');
      return;
    }

    setIsSaving(true);
    const channels: ('in_app' | 'whatsapp')[] = [];
    if (channelInApp) channels.push('in_app');
    if (channelWhatsApp) channels.push('whatsapp');

    if (channels.length === 0) {
      setIsSaving(false);
      toast.error('Selecciona al menos un canal de notificación');
      return;
    }

    const payload = {
      cliente_id: selectedCliente === 'global' ? null : selectedCliente,
      tab_id: selectedTab === 'overall' || selectedCliente === 'global' ? null : selectedTab,
      nombre: ruleName.trim(),
      metric: selectedMetric,
      operator: selectedOperator,
      value: parseFloat(thresholdValue),
      time_window: selectedWindow,
      custom_start: selectedWindow === 'custom_range' ? customStart || null : null,
      custom_end: selectedWindow === 'custom_range' ? customEnd || null : null,
      channels,
      cooldown_hours: parseInt(cooldown) || 24,
      enabled: isEnabled,
    };

    try {
      if (editingRuleId) {
        const res = await updateNotificationRule(editingRuleId, payload);
        if (res.error) throw new Error(res.error);
        toast.success('Regla actualizada correctamente');
      } else {
        const res = await createNotificationRule(payload);
        if (res.error) throw new Error(res.error);
        toast.success('Regla creada correctamente');
      }

      // Reload local rules state
      const { getNotificationRules } = await import('../_actions');
      const updatedRules = await getNotificationRules();
      setRules(updatedRules);
      setIsDialogOpen(false);
    } catch (err: any) {
      toast.error(err.message || 'Error al guardar regla');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteRule = async (id: string) => {
    if (!confirm('¿Estás seguro de que deseas eliminar esta regla?')) return;

    try {
      const res = await deleteNotificationRule(id);
      if (res.error) throw new Error(res.error);
      toast.success('Regla eliminada');
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (err: any) {
      toast.error(err.message || 'Error al eliminar regla');
    }
  };

  const handleToggleEnabled = async (rule: RuleRow, val: boolean) => {
    try {
      const res = await updateNotificationRule(rule.id, { enabled: val });
      if (res.error) throw new Error(res.error);
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled: val } : r))
      );
      toast.success(val ? 'Regla habilitada' : 'Regla deshabilitada');
    } catch (err: any) {
      toast.error(err.message || 'Error al actualizar regla');
    }
  };

  const handleTestRule = async (ruleId: string) => {
    setTestingId(ruleId);
    setTestResult(null);
    setIsTestOpen(true);

    try {
      const res = await testRule(ruleId);
      if (res.error) {
        setTestResult({ error: res.error });
      } else {
        setTestResult(res);
      }
    } catch (err: any) {
      setTestResult({ error: err.message || 'Error de red al ejecutar test' });
    } finally {
      setTestingId(null);
    }
  };

  const handleRunEvaluation = async () => {
    setIsEvaluating(true);
    try {
      const res = await triggerRulesEvaluation();
      if ('error' in res && res.error) throw new Error(res.error);
      if ('evaluated' in res && 'triggered' in res) {
        toast.success(`Evaluación completada. Reglas evaluadas: ${res.evaluated}, Alertas disparadas: ${res.triggered}`);
      }
    } catch (err: any) {
      toast.error(err.message || 'Error ejecutando evaluación');
    } finally {
      setIsEvaluating(false);
    }
  };

  return (
    <div className="w-full">
      <Tabs defaultValue="alertas" className="w-full">
        <TabsList className="bg-muted/80 p-1 rounded-lg mb-6 flex w-fit gap-1">
          <TabsTrigger
            value="alertas"
            className="data-[state=active]:bg-card rounded-md px-4 py-2 flex items-center gap-2 text-sm font-medium"
          >
            <BellRing className="h-4 w-4 text-amber-500" />
            Alertas Condicionales
          </TabsTrigger>
          <TabsTrigger
            value="whatsapp"
            className="data-[state=active]:bg-card rounded-md px-4 py-2 flex items-center gap-2 text-sm font-medium"
          >
            <MessageCircle className="h-4 w-4 text-emerald-500" />
            WhatsApp
          </TabsTrigger>
          <TabsTrigger
            value="usuarios"
            className="data-[state=active]:bg-card rounded-md px-4 py-2 flex items-center gap-2 text-sm font-medium"
          >
            <Users className="h-4 w-4 text-violet-500" />
            Gestión de Usuarios
          </TabsTrigger>
          <TabsTrigger
            value="mcp"
            className="data-[state=active]:bg-card rounded-md px-4 py-2 flex items-center gap-2 text-sm font-medium"
          >
            <Zap className="h-4 w-4 text-violet-500" />
            Servidor MCP & API
          </TabsTrigger>
          {currentRole === 'superadmin' && (
            <TabsTrigger
              value="branding"
              className="data-[state=active]:bg-card rounded-md px-4 py-2 flex items-center gap-2 text-sm font-medium"
            >
              <Palette className="h-4 w-4 text-pink-500" />
              Personalización
            </TabsTrigger>
          )}
        </TabsList>

        {/* ── ALERTS TAB ─────────────────────────────────────────────────── */}
        <TabsContent value="alertas" className="space-y-6 outline-none">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h3 className="text-xl font-bold text-foreground">Configurador de Alertas</h3>
              <p className="text-sm text-muted-foreground">
                Configura límites para ROAS, presupuestos o CPL y recibe avisos por WhatsApp e in-app.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={isEvaluating}
                onClick={handleRunEvaluation}
                className="flex items-center gap-1.5 border-border hover:bg-muted font-medium"
              >
                <RotateCcw className={`h-4 w-4 ${isEvaluating ? 'animate-spin' : ''}`} />
                Evaluar Ahora
              </Button>
              <Button onClick={handleOpenNewDialog} className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white font-medium">
                <Plus className="h-4 w-4" />
                Nueva Regla
              </Button>
            </div>
          </div>

          <Card className="bg-card border-border shadow-lg">
            <CardHeader className="py-4 px-6 border-b border-border">
              <CardTitle className="text-lg">Reglas de Alerta Activas</CardTitle>
              <CardDescription>
                Se ejecutan automáticamente cada madrugada tras importar nuevas métricas.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {rules.length === 0 ? (
                <div className="p-12 text-center text-muted-foreground">
                  <VolumeX className="h-10 w-10 text-muted-foreground/50 mx-auto mb-3" />
                  <p className="text-base font-semibold">No hay reglas de alerta configuradas</p>
                  <p className="text-sm mt-1 mb-4">Crea tu primera regla para empezar a monitorear presupuestos y ROAS.</p>
                  <Button variant="outline" onClick={handleOpenNewDialog} className="border-border hover:bg-muted">
                    Crear primera regla
                  </Button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-muted/30">
                      <TableRow className="border-b border-border">
                        <TableHead className="w-1/4">Nombre</TableHead>
                        <TableHead className="w-1/5">Alcance</TableHead>
                        <TableHead className="w-1/4">Condición de Disparo</TableHead>
                        <TableHead className="w-1/8">Canales</TableHead>
                        <TableHead className="w-1/10 text-center">Estado</TableHead>
                        <TableHead className="w-1/6 text-right">Acciones</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rules.map((rule) => {
                        const clientName = rule.cliente_id ? clientMap.get(rule.cliente_id) || 'Cargando...' : 'Global (Todos)';
                        const tabName = rule.tab_id ? tabMap.get(rule.tab_id) || 'Pestaña' : 'General/Completo';
                        const scopeStr = rule.cliente_id ? `${clientName} / ${tabName}` : 'Global';

                        const operatorSymbols: Record<string, string> = {
                          '>': 'mayor que',
                          '<': 'menor que',
                          '>=': 'mayor o igual a',
                          '<=': 'menor o igual a',
                        };

                        const formattedThresh = rule.metric === 'budget_percentage' ? `${rule.value}%` : rule.value.toString();

                        return (
                          <TableRow key={rule.id} className="border-b border-border hover:bg-muted/10">
                            <TableCell className="font-semibold text-foreground">{rule.nombre}</TableCell>
                            <TableCell className="text-muted-foreground text-sm">{scopeStr}</TableCell>
                            <TableCell className="font-mono text-sm">
                              <span className="text-amber-500 font-semibold">{METRIC_LABELS[rule.metric] || rule.metric}</span>{' '}
                              <span className="text-foreground">{rule.operator}</span>{' '}
                              <span className="text-emerald-500 font-semibold">{formattedThresh}</span>
                              <div className="text-[11px] text-muted-foreground font-sans mt-0.5">
                                Periodo: {WINDOW_LABELS[rule.time_window]} (Cooldown: {rule.cooldown_hours}h)
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {rule.channels.includes('in_app') && (
                                  <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/20 text-[10px] py-0.5">
                                    Campanita
                                  </Badge>
                                )}
                                {rule.channels.includes('whatsapp') && (
                                  <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-[10px] py-0.5">
                                    WhatsApp
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-center">
                              <ToggleSwitch
                                checked={rule.enabled}
                                onChange={(val) => handleToggleEnabled(rule, val)}
                              />
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  title="Probar regla ahora"
                                  onClick={() => handleTestRule(rule.id)}
                                  className="h-8 w-8 p-0 border-border hover:bg-muted"
                                >
                                  <Play className="h-3.5 w-3.5 text-blue-500" />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  title="Editar regla"
                                  onClick={() => handleOpenEditDialog(rule)}
                                  className="h-8 w-8 p-0 border-border hover:bg-muted"
                                >
                                  <Edit2 className="h-3.5 w-3.5 text-foreground" />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  title="Eliminar regla"
                                  onClick={() => handleDeleteRule(rule.id)}
                                  className="h-8 w-8 p-0 border-border hover:bg-red-500/10 hover:text-red-500"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── MCP CONFIG TAB ─────────────────────────────────────────────── */}
        <TabsContent value="mcp" className="outline-none">
          <ApiTokensManager baseUrl={baseUrl} />
        </TabsContent>

        {/* ── WHATSAPP TAB ───────────────────────────────────────────────── */}
        <TabsContent value="whatsapp" className="outline-none">
          <WhatsAppConfigClient
            status={waStatus}
            gatewayError={waGatewayError}
            qr={waQr}
            groups={waGroups}
            routes={waRoutes}
            clientes={waClientes}
            messages={waMessages}
            alertTeamGroup={waAlertTeamGroup}
          />
        </TabsContent>

        {/* ── USUARIOS TAB ───────────────────────────────────────────────── */}
        <TabsContent value="usuarios" className="outline-none">
          <UserManagementClient
            initialUsers={initialUsers}
            allClients={allClients}
            currentRole={currentRole}
            currentUserId={currentUserId}
          />
        </TabsContent>
        
        {/* ── PERSONALIZACIÓN TAB ─────────────────────────────────────────── */}
        {currentRole === 'superadmin' && (
          <TabsContent value="branding" className="outline-none">
            <Card className="bg-card border-border shadow-lg">
              <CardHeader className="py-4 px-6 border-b border-border">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Palette className="h-5 w-5 text-pink-500" />
                  Personalización Visual
                </CardTitle>
                <CardDescription>
                  Cambia el logo principal de la aplicación y la paleta de colores. Estos cambios se aplicarán para todos los usuarios.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6">
                <form onSubmit={handleSaveBranding} className="space-y-6">
                  
                  {/* Seccion LOGO */}
                  <div className="space-y-4">
                    <h4 className="text-sm font-semibold text-foreground border-b border-border pb-1.5">
                      Logo de la Aplicación
                    </h4>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-3">
                        <Label htmlFor="logo-url-input">URL del Logo</Label>
                        <Input
                          id="logo-url-input"
                          type="text"
                          value={logoUrl}
                          onChange={(e) => setLogoUrl(e.target.value)}
                          placeholder="https://ejemplo.com/logo.png"
                          className="bg-muted/50 border-border"
                        />
                        <p className="text-xs text-muted-foreground">
                          Puedes ingresar una URL directa de tu logo (SVG o PNG recomendado), o bien subir una imagen de tu equipo.
                        </p>
                        
                        <div className="pt-2">
                          <Label className="block mb-2 text-xs font-semibold">Subir imagen desde el equipo</Label>
                          <div className="flex items-center gap-2">
                            <label className="flex items-center gap-1.5 px-3 py-2 bg-muted hover:bg-muted/80 text-foreground text-xs font-medium rounded-md border border-border cursor-pointer transition-colors">
                              <Upload className="h-3.5 w-3.5" />
                              {uploadingLogo ? 'Subiendo...' : 'Seleccionar Archivo'}
                              <input
                                type="file"
                                accept="image/*"
                                onChange={handleLogoUpload}
                                disabled={uploadingLogo}
                                className="hidden"
                              />
                            </label>
                            {uploadingLogo && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                          </div>
                          <span className="text-[10px] text-muted-foreground mt-1 block">
                            Formatos soportados: PNG, JPG, WEBP, SVG. Máx. 2MB.
                          </span>
                        </div>
                      </div>

                      {/* Preview de logo */}
                      <div className="flex flex-col items-center justify-center p-4 border border-dashed border-border rounded-lg bg-muted/20">
                        <span className="text-xs font-semibold text-muted-foreground mb-3">Vista Previa del Logo</span>
                        {logoUrl ? (
                          <div className="flex flex-col items-center gap-2">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={logoUrl} alt="Logo Preview" className="h-12 max-h-12 w-auto object-contain bg-white dark:bg-zinc-900 p-2 rounded border border-border" />
                            <Button 
                              type="button" 
                              variant="ghost" 
                              size="sm" 
                              onClick={() => setLogoUrl('')} 
                              className="text-[10px] text-red-500 hover:text-red-600 h-6 px-2"
                            >
                              Eliminar logo
                            </Button>
                          </div>
                        ) : (
                          <div className="text-center p-4 text-xs text-muted-foreground/60">
                            No hay un logo personalizado configurado. Se mostrará el logo original (AdsHouse).
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Seccion NOMBRES */}
                  <div className="space-y-4 pt-2">
                    <h4 className="text-sm font-semibold text-foreground border-b border-border pb-1.5">
                      Nombres y Etiquetas de la Aplicación
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      Define los títulos y etiquetas que se mostrarán en la barra lateral y en las páginas de login/registro cuando no haya un logo personalizado activo.
                    </p>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold">Nombre Principal (App)</Label>
                        <Input
                          type="text"
                          value={appName}
                          onChange={(e) => setAppName(e.target.value)}
                          placeholder="Ej. AdsHouse"
                          className="h-9 bg-muted/50 border-border"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold">Subtítulo / Etiqueta (App)</Label>
                        <Input
                          type="text"
                          value={appTag}
                          onChange={(e) => setAppTag(e.target.value)}
                          placeholder="Ej. Reporting"
                          className="h-9 bg-muted/50 border-border"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold">Nombre Principal (Report-UTM)</Label>
                        <Input
                          type="text"
                          value={utmName}
                          onChange={(e) => setUtmName(e.target.value)}
                          placeholder="Ej. Report-UTM"
                          className="h-9 bg-muted/50 border-border"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs font-semibold">Subtítulo / Etiqueta (Report-UTM)</Label>
                        <Input
                          type="text"
                          value={utmTag}
                          onChange={(e) => setUtmTag(e.target.value)}
                          placeholder="Ej. Tracking & Atribución"
                          className="h-9 bg-muted/50 border-border"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Seccion COLORES */}
                  <div className="space-y-4 pt-2">
                    <h4 className="text-sm font-semibold text-foreground border-b border-border pb-1.5">
                      Paleta de Colores de la Aplicación
                    </h4>

                    {/* Predefined Themes */}
                    <div className="space-y-2">
                      <Label className="text-xs font-semibold">Temas Rápidos de Color</Label>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2.5">
                        {PREDEFINED_THEMES.map((theme) => {
                          const isActive = primaryColor.toLowerCase() === theme.primary.toLowerCase() && secondaryColor.toLowerCase() === theme.secondary.toLowerCase();
                          return (
                            <button
                              key={theme.name}
                              type="button"
                              onClick={() => {
                                setPrimaryColor(theme.primary);
                                setSecondaryColor(theme.secondary);
                              }}
                              className={`p-2.5 rounded-lg border text-left flex flex-col justify-between h-20 transition-all ${
                                isActive 
                                  ? 'border-foreground shadow-sm ring-1 ring-foreground/20 bg-muted/40' 
                                  : 'border-border hover:border-muted-foreground/40 bg-card'
                              }`}
                            >
                              <span className="text-[11px] font-bold text-foreground truncate w-full">{theme.name}</span>
                              <div className="flex gap-1.5 mt-2">
                                <div className="w-5 h-5 rounded-full border border-black/10" style={{ backgroundColor: theme.primary }} title="Color Primario" />
                                <div className="w-5 h-5 rounded-full border border-black/10" style={{ backgroundColor: theme.secondary }} title="Color Secundario" />
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                      {/* Color Pickers */}
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <Label htmlFor="primary-color-picker">Color Primario (Blue)</Label>
                            <div className="flex gap-2">
                              <Input
                                id="primary-color-picker"
                                type="color"
                                value={primaryColor}
                                onChange={(e) => setPrimaryColor(e.target.value)}
                                className="w-10 h-10 p-0 border border-border rounded cursor-pointer"
                              />
                              <Input
                                type="text"
                                value={primaryColor}
                                onChange={(e) => setPrimaryColor(e.target.value)}
                                className="flex-1 bg-muted/50 border-border font-mono text-xs"
                                placeholder="#1E6AB5"
                              />
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <Label htmlFor="secondary-color-picker">Color Secundario (Red)</Label>
                            <div className="flex gap-2">
                              <Input
                                id="secondary-color-picker"
                                type="color"
                                value={secondaryColor}
                                onChange={(e) => setSecondaryColor(e.target.value)}
                                className="w-10 h-10 p-0 border border-border rounded cursor-pointer"
                              />
                              <Input
                                type="text"
                                value={secondaryColor}
                                onChange={(e) => setSecondaryColor(e.target.value)}
                                className="flex-1 bg-muted/50 border-border font-mono text-xs"
                                placeholder="#E53529"
                              />
                            </div>
                          </div>
                        </div>

                        <p className="text-xs text-muted-foreground leading-normal">
                          El <b>Color Primario</b> se usará para la barra lateral activa, botones principales, enlaces y bordes de enfoque. El <b>Color Secundario</b> se aplicará en avisos críticos, insignias y elementos acentuados.
                        </p>
                      </div>

                      {/* Live preview */}
                      <div className="border border-border rounded-lg p-4 bg-muted/10 space-y-3">
                        <span className="text-xs font-semibold text-muted-foreground block">
                          Previsualización en Tiempo Real
                        </span>
                        
                        <div className="border border-border rounded-lg overflow-hidden flex h-36 bg-background">
                          {/* Sidebar mockup */}
                          <div className="w-16 border-r border-border bg-card flex flex-col p-1.5 space-y-1.5 justify-between">
                            <div className="space-y-1.5">
                              <div className="h-4 rounded flex items-center justify-center text-[7px] font-bold" style={{ background: `linear-gradient(135deg, ${secondaryColor} 0%, ${primaryColor} 100%)`, color: '#fff' }}>
                                LOGO
                              </div>
                              <div className="h-3 w-full rounded" style={{ backgroundColor: primaryColor }} />
                              <div className="h-3 w-5/6 rounded bg-muted" />
                              <div className="h-3 w-3/4 rounded bg-muted" />
                            </div>
                            <div className="h-3 w-full rounded bg-muted" />
                          </div>
                          
                          {/* Content mockup */}
                          <div className="flex-1 p-3 flex flex-col justify-between">
                            <div className="space-y-1.5">
                              <div className="h-2 w-1/3 rounded bg-muted" />
                              <div className="h-4 w-1/2 rounded" style={{ backgroundColor: primaryColor }} />
                              <div className="h-2 w-full rounded bg-muted/50" />
                              <div className="h-2 w-full rounded bg-muted/50" />
                            </div>
                            <div className="flex gap-2">
                              <button type="button" className="h-5 px-2 rounded text-[8px] font-medium text-white shadow-sm flex items-center" style={{ backgroundColor: primaryColor }}>
                                Guardar
                              </button>
                              <button type="button" className="h-5 px-2 rounded text-[8px] font-medium border border-border bg-card flex items-center" style={{ color: secondaryColor, borderColor: `${secondaryColor}40` }}>
                                Alerta Activa
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Submit Button */}
                  <div className="border-t border-border pt-4 flex justify-end gap-3">
                    <Button 
                      type="button" 
                      variant="outline" 
                      onClick={() => {
                        setLogoUrl(initialBranding?.logo_url || '');
                        setPrimaryColor(initialBranding?.colors?.primary || '#1E6AB5');
                        setSecondaryColor(initialBranding?.colors?.secondary || '#E53529');
                        setAppName(initialBranding?.app_name || 'AdsHouse');
                        setAppTag(initialBranding?.app_tag || 'Reporting');
                        setUtmName(initialBranding?.utm_name || 'Report-UTM');
                        setUtmTag(initialBranding?.utm_tag || 'Tracking & Atribución');
                        toast.info('Cambios restablecidos');
                      }}
                      className="border-border hover:bg-muted text-xs"
                    >
                      Deshacer Cambios
                    </Button>
                    <Button
                      type="submit"
                      disabled={savingBranding || uploadingLogo}
                      className="bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {savingBranding ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Guardando Ajustes...
                        </>
                      ) : (
                        'Guardar Branding'
                      )}
                    </Button>
                  </div>

                </form>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* ── NEW / EDIT RULE DIALOG ────────────────────────────────────── */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="bg-card border-border sm:max-w-[550px] max-h-[90vh] overflow-y-auto">
          <form onSubmit={handleSaveRule} className="space-y-4">
            <DialogHeader>
              <DialogTitle className="text-xl font-bold">
                {editingRuleId ? 'Editar Regla de Alerta' : 'Nueva Regla de Alerta'}
              </DialogTitle>
              <DialogDescription>
                Crea una condición. Si se cumple, el sistema despachará notificaciones.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              {/* Rule Name */}
              <div className="space-y-1.5">
                <Label htmlFor="rule-name">Nombre de la Regla</Label>
                <Input
                  id="rule-name"
                  value={ruleName}
                  onChange={(e) => setRuleName(e.target.value)}
                  placeholder="Ej. Alerta ROAS bajo, Alerta Presupuesto 90%"
                  className="bg-muted/50 border-border"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Client Select */}
                <div className="space-y-1.5">
                  <Label>Cliente</Label>
                  <Select value={selectedCliente} onValueChange={(val) => {
                    setSelectedCliente(val);
                    setSelectedTab('overall');
                  }}>
                    <SelectTrigger className="bg-muted/50 border-border">
                      <SelectValue placeholder="Selecciona un cliente" />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-border">
                      <SelectItem value="global">Todos (Global)</SelectItem>
                      {clientes.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.nombre}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Tab Select */}
                <div className="space-y-1.5">
                  <Label>Pestaña (Filtro Campañas)</Label>
                  <Select
                    value={selectedTab}
                    onValueChange={setSelectedTab}
                    disabled={selectedCliente === 'global'}
                  >
                    <SelectTrigger className="bg-muted/50 border-border disabled:opacity-50">
                      <SelectValue placeholder="Toda la cuenta" />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-border">
                      <SelectItem value="overall">Toda la cuenta (General)</SelectItem>
                      {filteredTabs.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.nombre}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                {/* Metric */}
                <div className="col-span-2 space-y-1.5">
                  <Label>Métrica</Label>
                  <Select
                    value={selectedMetric}
                    onValueChange={(val: any) => {
                      setSelectedMetric(val);
                      if (val === 'budget_percentage') {
                        setSelectedWindow('current_tab_period');
                      }
                    }}
                  >
                    <SelectTrigger className="bg-muted/50 border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-border">
                      {Object.entries(METRIC_LABELS).map(([k, label]) => (
                        <SelectItem key={k} value={k}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Operators */}
                <div className="space-y-1.5">
                  <Label>Condición</Label>
                  <Select
                    value={selectedOperator}
                    onValueChange={(val: any) => setSelectedOperator(val)}
                  >
                    <SelectTrigger className="bg-muted/50 border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-border">
                      <SelectItem value=">">mayor a ({'>'})</SelectItem>
                      <SelectItem value="<">menor a ({'<'})</SelectItem>
                      <SelectItem value=">=">mayor o igual ({'>='})</SelectItem>
                      <SelectItem value="<=">menor o igual ({'<='})</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Threshold value */}
                <div className="space-y-1.5">
                  <Label htmlFor="threshold">Valor Umbral</Label>
                  <Input
                    id="threshold"
                    type="number"
                    step="any"
                    value={thresholdValue}
                    onChange={(e) => setThresholdValue(e.target.value)}
                    placeholder="Ej: 90 para presupuesto, 2.5 para ROAS"
                    className="bg-muted/50 border-border"
                  />
                </div>

                {/* Time Window */}
                <div className="space-y-1.5">
                  <Label>Periodo de Tiempo</Label>
                  <Select
                    value={selectedWindow}
                    onValueChange={(val: any) => setSelectedWindow(val)}
                  >
                    <SelectTrigger className="bg-muted/50 border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-border">
                      {Object.entries(WINDOW_LABELS).map(([k, label]) => (
                        <SelectItem key={k} value={k}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Custom date range inputs */}
              {selectedWindow === 'custom_range' && (
                <div className="grid grid-cols-2 gap-4 bg-muted/30 border border-border rounded-lg p-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="custom-start" className="text-xs">Fecha de Inicio</Label>
                    <Input
                      id="custom-start"
                      type="date"
                      value={customStart}
                      onChange={(e) => setCustomStart(e.target.value)}
                      className="bg-muted/50 border-border text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="custom-end" className="text-xs">Fecha de Fin</Label>
                    <Input
                      id="custom-end"
                      type="date"
                      value={customEnd}
                      onChange={(e) => setCustomEnd(e.target.value)}
                      className="bg-muted/50 border-border text-sm"
                    />
                  </div>
                </div>
              )}

              {/* Channels checkboxes */}
              <div className="space-y-2 border-t border-border pt-3">
                <Label>Canales de Notificación</Label>
                <div className="flex gap-6 mt-1">
                  <label className="flex items-center gap-2 text-sm font-medium text-muted-foreground cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={channelInApp}
                      onChange={(e) => setChannelInApp(e.target.checked)}
                      className="rounded border-border bg-muted h-4 w-4 accent-blue-600 cursor-pointer"
                    />
                    Notificación Interna (Campanita)
                  </label>
                  <label className="flex items-center gap-2 text-sm font-medium text-muted-foreground cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={channelWhatsApp}
                      onChange={(e) => setChannelWhatsApp(e.target.checked)}
                      className="rounded border-border bg-muted h-4 w-4 accent-blue-600 cursor-pointer"
                    />
                    Enviar a WhatsApp de Cliente
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 border-t border-border pt-3">
                {/* Cooldown */}
                <div className="space-y-1.5">
                  <Label htmlFor="cooldown">Frecuencia / Cooldown (Horas)</Label>
                  <Input
                    id="cooldown"
                    type="number"
                    value={cooldown}
                    onChange={(e) => setCooldown(e.target.value)}
                    placeholder="24"
                    className="bg-muted/50 border-border"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Tiempo de espera mínimo antes de volver a disparar otra alerta por esta regla.
                  </p>
                </div>

                {/* Enabled Toggle */}
                <div className="flex flex-col justify-end space-y-1.5 pb-2">
                  <div className="flex items-center gap-3">
                    <ToggleSwitch checked={isEnabled} onChange={setIsEnabled} />
                    <Label className="cursor-pointer" onClick={() => setIsEnabled(!isEnabled)}>
                      Regla Habilitada
                    </Label>
                  </div>
                </div>
              </div>
            </div>

            <DialogFooter className="border-t border-border pt-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsDialogOpen(false)}
                className="border-border hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={isSaving}
                className="bg-blue-600 hover:bg-blue-500 text-white font-medium disabled:opacity-50"
              >
                {isSaving ? 'Guardando...' : editingRuleId ? 'Actualizar Regla' : 'Crear Regla'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── TEST RULE MODAL ───────────────────────────────────────────── */}
      <Dialog open={isTestOpen} onOpenChange={setIsTestOpen}>
        <DialogContent className="bg-card border-border sm:max-w-[450px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg font-bold">
              <Play className="h-5 w-5 text-blue-500" />
              Resultado de Simulación
            </DialogTitle>
            <DialogDescription>
              Cálculo en tiempo real utilizando las métricas históricas de la base de datos.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {testingId ? (
              <div className="flex flex-col items-center justify-center p-8 space-y-3">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
                <p className="text-sm text-muted-foreground">Calculando métricas del periodo...</p>
              </div>
            ) : testResult?.error ? (
              <div className="bg-red-500/10 border border-red-500/20 text-red-500 p-4 rounded-lg flex items-start gap-3">
                <XCircle className="h-5 w-5 shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-semibold">Error al evaluar</p>
                  <p className="opacity-90">{testResult.error}</p>
                </div>
              </div>
            ) : testResult ? (
              <div className="space-y-4">
                {/* Result banner */}
                <div
                  className={`p-4 rounded-lg border flex items-center gap-3 ${
                    testResult.isTriggered
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-500'
                      : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-500'
                  }`}
                >
                  {testResult.isTriggered ? (
                    <AlertTriangle className="h-6 w-6 shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-6 w-6 shrink-0" />
                  )}
                  <div>
                    <p className="font-bold text-sm">
                      {testResult.isTriggered ? 'DISPARARÍA ALERTA' : 'CONDICIÓN NO CUMPLIDA (OK)'}
                    </p>
                    <p className="text-[11px] opacity-90">
                      El valor calculado ({testResult.actualValue.toFixed(2)}) {testResult.isTriggered ? 'cumple' : 'no cumple'} la condición {testResult.operator} {testResult.threshold}
                    </p>
                  </div>
                </div>

                {/* Metrics detail table */}
                <div className="bg-muted/40 border border-border rounded-lg p-3 space-y-2.5 text-sm font-sans">
                  <div className="flex justify-between border-b border-border/50 pb-1.5 text-xs text-muted-foreground">
                    <span>Métrica</span>
                    <span>Valor del Periodo</span>
                  </div>
                  <div className="flex justify-between font-mono">
                    <span className="text-muted-foreground font-sans">Cliente evaluado:</span>
                    <span className="font-semibold text-foreground">{testResult.clientName}</span>
                  </div>
                  {testResult.tabName && (
                    <div className="flex justify-between font-mono">
                      <span className="text-muted-foreground font-sans">Pestaña:</span>
                      <span className="font-semibold text-foreground">{testResult.tabName}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-mono">
                    <span className="text-muted-foreground font-sans">Rango evaluado:</span>
                    <span className="text-foreground text-xs font-semibold">
                      {testResult.start} al {testResult.end}
                    </span>
                  </div>
                  <div className="flex justify-between font-mono border-t border-border/50 pt-1.5">
                    <span className="text-muted-foreground font-sans">Gasto en periodo:</span>
                    <span className="text-foreground font-semibold">${testResult.totalSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                  </div>
                  <div className="flex justify-between font-mono">
                    <span className="text-muted-foreground font-sans">Leads en periodo:</span>
                    <span className="text-foreground font-semibold">{testResult.totalLeads}</span>
                  </div>
                  <div className="flex justify-between font-mono">
                    <span className="text-muted-foreground font-sans">Ingresos en periodo:</span>
                    <span className="text-foreground font-semibold">${testResult.totalRevenue.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                  </div>
                  {testResult.tabBudget && (
                    <div className="flex justify-between font-mono">
                      <span className="text-muted-foreground font-sans">Presupuesto Objetivo:</span>
                      <span className="text-foreground font-semibold">${testResult.tabBudget.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                    </div>
                  )}
                </div>

                {/* Budget warning banner */}
                {testResult.budgetWarning && (
                  <div className="bg-amber-500/10 border border-amber-500/25 rounded-lg p-3 flex items-start gap-2.5">
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      {testResult.budgetWarning}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-8 text-center text-muted-foreground">
                <HelpCircle className="h-8 w-8 mx-auto opacity-50 mb-2 animate-bounce" />
                <p className="text-sm">Iniciando simulación...</p>
              </div>
            )}
          </div>

          <DialogFooter className="border-t border-border pt-3">
            <Button onClick={() => setIsTestOpen(false)} className="bg-blue-600 hover:bg-blue-500 text-white font-medium">
              Entendido
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
