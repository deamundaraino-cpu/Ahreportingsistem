// Export del canvas BI a PDF. Client-only: usa html2canvas + jsPDF.
// Patrón equivalente al de los reportes mensuales.

export async function exportReportPdf(elementId: string, reportName: string): Promise<void> {
  const el = document.getElementById(elementId);
  if (!el) return;

  const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);

  // Fondo según el tema actual para que el PDF no salga transparente.
  const isDark = document.documentElement.classList.contains('dark');
  const bg = isDark ? '#0a0a0a' : '#ffffff';

  const canvas = await html2canvas(el, {
    scale: 2,
    backgroundColor: bg,
    useCORS: true,
    logging: false,
  });

  const imgData = canvas.toDataURL('image/png');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 24;

  const imgWidth = pageWidth - margin * 2;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  // Encabezado
  pdf.setFontSize(14);
  pdf.text(reportName, margin, margin);
  const headerOffset = margin + 12;

  // Si la imagen es más alta que una página, paginar por franjas.
  let remaining = imgHeight;
  let position = headerOffset;
  let sourceY = 0;
  const usableHeight = pageHeight - headerOffset - margin;

  if (imgHeight <= usableHeight) {
    pdf.addImage(imgData, 'PNG', margin, position, imgWidth, imgHeight);
  } else {
    // Recorta el canvas en páginas
    const ratio = imgWidth / canvas.width;
    const pagePixelHeight = usableHeight / ratio;
    while (remaining > 0) {
      const sliceHeight = Math.min(pagePixelHeight, canvas.height - sourceY);
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = sliceHeight;
      const ctx = slice.getContext('2d');
      if (ctx) {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(
          canvas,
          0,
          sourceY,
          canvas.width,
          sliceHeight,
          0,
          0,
          canvas.width,
          sliceHeight
        );
      }
      const sliceData = slice.toDataURL('image/png');
      pdf.addImage(sliceData, 'PNG', margin, position, imgWidth, sliceHeight * ratio);
      remaining -= usableHeight;
      sourceY += sliceHeight;
      if (remaining > 0) {
        pdf.addPage();
        position = margin;
      }
    }
  }

  const safeName = reportName.replace(/[^\w\-]+/g, '_').slice(0, 60) || 'informe';
  pdf.save(`${safeName}.pdf`);
}
