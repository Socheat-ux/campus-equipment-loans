import { prisma } from '../config/database.js';


export async function getAllAssets({ page = 1, limit = 10, search } = {}) {
  const skip = (page - 1) * limit;

  const where = search
    ? {
        OR: [
          {
            assetCode: {
              contains: search,
              mode: 'insensitive',
            },
          },
          {
            equipment: {
              name: {
                contains: search,
                mode: 'insensitive',
              },
            },
          },
        ],
      }
    : {};

  const [assets, total] = await prisma.$transaction([
    prisma.asset.findMany({
      where,
      include: {
        equipment: {
          include: {
            category: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: limit,
    }),

    prisma.asset.count({ where }),
  ]);

  return { assets, total };
}


// Get one asset

export async function getAssetById(id) {
  return prisma.asset.findUnique({
    where: { id },
    include: {
      equipment: {
        include: {
          category: true,
        },
      },
    },
  });
}


export async function getAssets(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
  const search = req.query.search?.trim();

  const { assets, total } = await getAllAssets({
    page,
    limit,
    search,
  });

  res.json({
    message: 'Assets retrieved successfully',
    data: assets,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}


// Create asset
export function createAsset(data) {
  return prisma.asset.create({
    data,
    include: {
      equipment: true,
    },
  });
}

// Update asset
export function updateAsset(id, data) {
  return prisma.asset.update({
    where: { id },
    data,
    include: {
      equipment: true,
    },
  });
}

// Delete asset
export function deleteAsset(id) {
  return prisma.asset.delete({
    where: { id },
  });
}