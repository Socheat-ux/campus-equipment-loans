// Schedule a periodic overdue scan here when the borrowing lifecycle is implemented.


import cron from 'node-cron';
import { prisma } from '../config/database.js';

export function startOverdueJob() {
  cron.schedule('* * * * *', async () => {
    console.log('Running overdue borrowing check...');

    try {
      const overdueBorrowings = await prisma.borrowing.findMany({
        where: {
          status: 'ACTIVE',
          dueAt: {
            lt: new Date(),
          },
        },
        select: {
          id: true,
          request: {
            select: {
              borrowerId: true,
            },
          },
        },
      });

      for (const borrowing of overdueBorrowings) {
        await prisma.$transaction(async (tx) => {
          // Update borrowing status only if it is still ACTIVE
          const result = await tx.borrowing.updateMany({
            where: {
              id: borrowing.id,
              status: 'ACTIVE',
            },
            data: {
              status: 'OVERDUE',
            },
          });

          // Create notification only when status was changed
          if (result.count === 1) {
            await tx.notification.create({
              data: {
                userId: borrowing.request.borrowerId,
                title: 'Equipment overdue',
                message: 'Your borrowed equipment is overdue. Please return it as soon as possible.',
                type: 'OVERDUE',
              },
            });
          }
        });
      }

      console.log(`Overdue check completed: ${overdueBorrowings.length} records found.`);
    } catch (error) {
      console.error('Overdue job failed:', error);
    }
  });

  console.log('Overdue detection job scheduled.');
}
