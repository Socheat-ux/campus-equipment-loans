import {
  issueBorrowing,
  returnBorrowing,
  getAllBorrowings,
  getMyBorrowings,
} from '../services/borrowing.service.js';


 // Admin: Get all borrowing records

export async function getAllBorrowingsHandler(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
  const search = req.query.search?.trim();
  const status = req.query.status?.toUpperCase();

  const allowedStatuses = ['ACTIVE', 'OVERDUE', 'RETURNED'];

  if (status && !allowedStatuses.includes(status)) {
    return res.status(400).json({
      message: 'Invalid borrowing status',
      allowedStatuses,
    });
  }

  const { borrowings, total } = await getAllBorrowings({
    page,
    limit,
    search,
    status,
  });

  res.json({
    message: 'Borrowings retrieved successfully',
    data: borrowings,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}

// Student and staff: Get personal borrowing history
export async function getMyBorrowingsHandler(req, res) {
  const borrowings = await getMyBorrowings(req.user.id);

  res.json(borrowings);
}
