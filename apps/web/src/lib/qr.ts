// Makes the QR code that opens the phone page on a real phone.

import qrcode from "qrcode-generator";

export function qrSvg(text: string, cellSize = 4): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 2, scalable: true });
}

export function phoneUrl(lanAddresses: string[] | undefined, employeeId?: string | null): string | null {
  const host = location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const base = isLocal ? lanAddresses?.[0] : host;
  if (!base) return null;
  const port = location.port ? `:${location.port}` : "";
  return `${location.protocol}//${base}${port}/device${employeeId ? `?employee=${employeeId}` : ""}`;
}
