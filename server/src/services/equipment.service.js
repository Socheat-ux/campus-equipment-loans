import { prisma } from "../config/database.js";

export async function listEquipment({ page = 1, limit = 10, search } = {}) {
  const skip = (page - 1) * limit;

  const where = search
    ? {
        name: {
          contains: search,
          mode: "insensitive",
        },
      }
    : {};

  const [equipment, total] = await prisma.$transaction([
    prisma.equipment.findMany({
      where,
      include: {
        category: true,
        _count: {
          select: {
            assets: true,
          },
        },
        assets: {
          where: {
            status: "AVAILABLE",
          },
          select: {
            id: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.equipment.count({ where }),
  ]);

  return { equipment, total };
}

export function getEquipmentById(id) {
  return prisma.equipment.findUnique({
    where: { id },
    include: {
      category: true,
      assets: true,
    },
  });
}


export function createEquipment(data) {
  return prisma.equipment.create({
    data,
    include: {
      category: true,
    },
  });
}

export function updateEquipment(id, data) {
  return prisma.equipment.update({
    where: { id },
    data,
    include: {
      category: true,
    },
  });
}

export function deleteEquipment(id) {
  return prisma.equipment.delete({
    where: { id },
  });
}
