import { prisma } from '../config/database.js';

// Create a borrowing request
export async function createBorrowRequest(borrowerId, data) {
  return prisma.$transaction(async (tx) => {
    const asset = await tx.asset.findUnique({
      where: { id: data.assetId },
    });

    if (!asset) {
      const error = new Error('Asset not found');
      error.status = 404;
      throw error;
    }

    if (asset.status !== 'AVAILABLE') {
      const error = new Error('Asset is not available');
      error.status = 409;
      throw error;
    }

    const overlappingRequest = await tx.borrowRequest.findFirst({
      where: {
        assetId: data.assetId,
        status: 'APPROVED',
        requestedStart: { lt: data.requestedEnd },
        requestedEnd: { gt: data.requestedStart },
      },
    });

    if (overlappingRequest) {
      const error = new Error('Asset is already reserved for these dates');
      error.status = 409;
      throw error;
    }

    return tx.borrowRequest.create({
      data: {
        borrowerId,
        assetId: data.assetId,
        requestedStart: data.requestedStart,
        requestedEnd: data.requestedEnd,
        purpose: data.purpose,
      },
      include: {
        asset: {
          include: {
            equipment: true,
          },
        },
      },
    });
  });
}

// Get requests belonging to one borrower
export function getMyBorrowRequests(borrowerId) {
  return prisma.borrowRequest.findMany({
    where: { borrowerId },
    include: {
      asset: {
        include: {
          equipment: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

// Get all borrowing requests (Admin)
export function getAllBorrowRequests() {
  return prisma.borrowRequest.findMany({
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
    orderBy: {
      createdAt: 'desc',
    },
  });
}

// Admin approves or rejects a borrowing request
export async function reviewBorrowRequest(requestId, adminId, data) {
  return prisma.$transaction(async (tx) => {
    // 1. Find the borrowing request
    const existingRequest = await tx.borrowRequest.findUnique({
      where: { id: requestId },
      include: { asset: true },
    });

    if (!existingRequest) {
      const error = new Error('Borrowing request not found');
      error.status = 404;
      throw error;
    }

    // 2. Only pending requests can be reviewed
    if (existingRequest.status !== 'PENDING') {
      const error = new Error('This request has already been reviewed');
      error.status = 409;
      throw error;
    }

    // 3. Check asset availability before approval
    if (data.status === 'APPROVED') {
      if (existingRequest.asset.status !== 'AVAILABLE') {
        const error = new Error('Asset is no longer available');
        error.status = 409;
        throw error;
      }

      const overlappingRequest = await tx.borrowRequest.findFirst({
        where: {
          id: { not: requestId },
          assetId: existingRequest.assetId,
          status: 'APPROVED',
          requestedStart: { lt: existingRequest.requestedEnd },
          requestedEnd: { gt: existingRequest.requestedStart },
        },
      });

      if (overlappingRequest) {
        const error = new Error('Asset is already reserved for these dates');
        error.status = 409;
        throw error;
      }

      // Reserve the asset
      await tx.asset.update({
        where: { id: existingRequest.assetId },
        data: { status: 'RESERVED' },
      });
    }

    // 4. Update the borrowing request
    const updatedRequest = await tx.borrowRequest.update({
      where: { id: requestId },
      data: {
        status: data.status,
        rejectionReason:
          data.status === 'REJECTED' ? data.rejectionReason : null,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
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
    });

    // 5. Create audit log
    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: `BORROW_REQUEST_${data.status}`,
        entityType: 'BorrowRequest',
        entityId: requestId,
        details: {
          previousStatus: 'PENDING',
          newStatus: data.status,
          borrowerId: existingRequest.borrowerId,
          assetId: existingRequest.assetId,
          rejectionReason:
            data.status === 'REJECTED' ? data.rejectionReason : null,
        },
      },
    });

    return updatedRequest;
  });
}

export async function issueBorrowing(requestId, adminId) {
  return prisma.$transaction(async (tx) => {
    // 1. Find the borrowing request
    const request = await tx.borrowRequest.findUnique({
      where: { id: requestId },
      include: { asset: true },
    });

    if (!request) {
      const error = new Error('Borrowing request not found');
      error.status = 404;
      throw error;
    }

    // 2. Only approved requests can be issued
    if (request.status !== 'APPROVED') {
      const error = new Error('Only approved requests can be issued');
      error.status = 409;
      throw error;
    }

    // 3. Check asset status
    if (request.asset.status !== 'RESERVED') {
      const error = new Error('Asset is not reserved');
      error.status = 409;
      throw error;
    }

    // 4. Prevent duplicate borrowing records
    const existingBorrowing = await tx.borrowing.findUnique({
      where: { requestId },
    });

    if (existingBorrowing) {
      const error = new Error('This request has already been issued');
      error.status = 409;
      throw error;
    }

    // 5. Create borrowing record
    const borrowing = await tx.borrowing.create({
      data: {
        requestId,
        issuedBy: adminId,
        dueAt: request.requestedEnd,
      },
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
      },
    });

    // 6. Update asset status
    await tx.asset.update({
      where: { id: request.assetId },
      data: { status: 'BORROWED' },
    });

    // 7. Create audit log
    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'EQUIPMENT_ISSUED',
        entityType: 'Borrowing',
        entityId: borrowing.id,
        details: {
          requestId,
          assetId: request.assetId,
          borrowerId: request.borrowerId,
          assetCode: request.asset.assetCode,
        },
      },
    });

    return borrowing;
  });
}



export async function returnBorrowing(borrowingId, adminId, data) {
  return prisma.$transaction(async (tx) => {
    // 1. Find the borrowing record
    const borrowing = await tx.borrowing.findUnique({
      where: { id: borrowingId },
      include: {
        request: {
          include: {
            asset: true,
          },
        },
      },
    });

    if (!borrowing) {
      const error = new Error('Borrowing record not found');
      error.status = 404;
      throw error;
    }

    // 2. Only active or overdue borrowings can be returned
    if (!['ACTIVE', 'OVERDUE'].includes(borrowing.status)) {
      const error = new Error('This equipment has already been returned');
      error.status = 409;
      throw error;
    }

    // 3. Create the return record
    const returnRecord = await tx.returnRecord.create({
      data: {
        borrowingId,
        receivedBy: adminId,
        condition: data.condition,
        notes: data.notes,
      },
    });

    // 4. Update borrowing status
    await tx.borrowing.update({
      where: { id: borrowingId },
      data: {
        status: 'RETURNED',
        returnedAt: new Date(),
      },
    });

    // 5. Update asset condition and availability
    const assetStatus =
      data.condition === 'DAMAGED' ? 'MAINTENANCE' : 'AVAILABLE';

    const asset = await tx.asset.update({
      where: { id: borrowing.request.assetId },
      data: {
        condition: data.condition,
        status: assetStatus,
      },
    });

    // 6. Create audit log
    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'EQUIPMENT_RETURNED',
        entityType: 'Borrowing',
        entityId: borrowingId,
        details: {
          assetId: asset.id,
          assetCode: asset.assetCode,
          previousStatus: borrowing.status,
          newStatus: 'RETURNED',
          condition: data.condition,
          assetStatus: asset.status,
        },
      },
    });

    return {
      returnRecord,
      borrowing: {
        id: borrowingId,
        status: 'RETURNED',
      },
      asset: {
        id: asset.id,
        assetCode: asset.assetCode,
        condition: asset.condition,
        status: asset.status,
      },
    };
  });
}
