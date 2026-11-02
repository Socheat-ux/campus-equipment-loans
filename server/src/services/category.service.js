import { prisma } from '../config/database.js';

export function getAllCategories() {
  return prisma.category.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: { equipment: true },
      },
    },
  });
}

export function getCategoryById(id) {
  return prisma.category.findUnique({
    where: { id },
    include: {
      equipment: true,
    },
  });
}

export function createCategory(data) {
  return prisma.category.create({
    data,
  });
}

export function updateCategory(id, data) {
  return prisma.category.update({
    where: { id },
    data,
  });
}

export function deleteCategory(id) {
  return prisma.category.delete({
    where: { id },
  });
}