import {
  getAllAssets,
  getAssetById,
  createAsset,
  updateAsset,
  deleteAsset,
} from '../services/asset.service.js';
import { generateAssetQRCode } from '../services/qr.service.js';
import { prisma } from '../config/database.js';
import {
  createAssetSchema,
  updateAssetSchema,
} from '../validators/asset.validator.js';

export async function getAssets(req, res) {
  const assets = await getAllAssets();
  res.json(assets);
}

export async function getAsset(req, res) {
  const asset = await getAssetById(req.params.id);

  if (!asset) {
    return res.status(404).json({ error: 'Asset not found' });
  }

  res.json(asset);
}

export async function createAssetHandler(req, res) {
  const data = createAssetSchema.parse(req.body);
  const asset = await createAsset(data);

  res.status(201).json({
    message: 'Asset created successfully',
    asset,
  });
}

export async function updateAssetHandler(req, res) {
  const data = updateAssetSchema.parse(req.body);
  const asset = await updateAsset(req.params.id, data);

  res.json({
    message: 'Asset updated successfully',
    asset,
  });
}

export async function deleteAssetHandler(req, res) {
  await deleteAsset(req.params.id);

  res.json({ message: 'Asset deleted successfully' });
}

export async function getAssetQRCode(req, res) {
  const asset = await prisma.asset.findUnique({
    where: { id: req.params.id },
    select: {
      id: true,
      assetCode: true,
      qrToken: true,
    },
  });

  if (!asset) {
    return res.status(404).json({
      error: 'Asset not found',
    });
  }

  const qrCode = await generateAssetQRCode(asset.qrToken);

  res.json({
    message: 'QR code generated successfully',
    assetCode: asset.assetCode,
    qrCode,
  });
}
export async function scanAsset(req, res) {
  const { qrToken } = req.params;

  const asset = await prisma.asset.findUnique({
    where: { qrToken },
    include: {
      equipment: {
        include: {
          category: true,
        },
      },
    },
  });

  if (!asset) {
    return res.status(404).json({
      error: 'Asset not found',
    });
  }

  res.json({
    message: 'Asset found successfully',
    asset,
  });
}