import QRCode from 'qrcode';
import { env } from '../config/env.js';

export async function generateAssetQRCode(qrToken) {
  const scanUrl = `${env.clientOrigin}/scan/${qrToken}`;

  return QRCode.toDataURL(scanUrl, {
    errorCorrectionLevel: 'H',
    type: 'image/png',
    width: 400,
    margin: 2,
  });
}