
export async function getAllBorrowings({
  page = 1,
  limit = 10,
  search,
  status,
} = {}) {
  const skip = (page - 1) * limit;

  const where = {
    ...(status ? { status } : {}),
    ...(search
      ? {
          request: {
            OR: [
              {
                borrower: {
                  name: {
                    contains: search,
                    mode: 'insensitive',
                  },
                },
              },
              {
                asset: {
                  assetCode: {
                    contains: search,
                    mode: 'insensitive',
                  },
                },
              },
            ],
          },
        }
      : {}),
  };

  const [borrowings, total] = await prisma.$transaction([
    prisma.borrowing.findMany({
      where,
      include: {
        request: {
          include: {
            borrower: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            asset: {
              include: {
                equipment: true,
              },
            },
          },
        },
        issuer: {
          select: {
            id: true,
            name: true,
          },
        },
        returnRecord: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: limit,
    }),

    prisma.borrowing.count({ where }),
  ]);

  return { borrowings, total };
}
