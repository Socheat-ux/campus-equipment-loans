import {
  createBorrowRequest,
  getMyBorrowRequests,
  reviewBorrowRequest,
  getAllBorrowRequests,
} from '../services/borrow-request.service.js';
import { returnEquipmentSchema } from '../validators/return.validator.js';
import {
  createBorrowRequestSchema,
   reviewBorrowRequestSchema,
} from '../validators/borrow-request.validator.js';

import { issueBorrowing, returnBorrowing, } from '../services/borrow-request.service.js';

// Admin issues approved equipment
export async function issueBorrowingHandler(req, res) {
  const borrowing = await issueBorrowing(
    req.params.requestId,
    req.user.id
  );

  res.status(201).json({
    message: 'Equipment issued successfully',
    borrowing,
  });
}

export async function createBorrowRequestHandler(req, res) {
  const data = createBorrowRequestSchema.parse(req.body);

  const request = await createBorrowRequest(req.user.id, data);

  res.status(201).json({
    message: 'Borrowing request submitted successfully',
    request,
  });
}

export async function getMyBorrowRequestsHandler(req, res) {
  const requests = await getMyBorrowRequests(req.user.id);

  res.json(requests);
}

export async function getAllBorrowRequestsHandler(req, res) {
  const requests = await getAllBorrowRequests();

  res.json(requests);
}

export async function reviewBorrowRequestHandler(req, res) {
  const data = reviewBorrowRequestSchema.parse(req.body);

  const request = await reviewBorrowRequest(
    req.params.id,
    req.user.id,
    data
  );

  res.json({
    message: `Borrowing request ${data.status.toLowerCase()} successfully`,
    request,
  });
}


export async function returnBorrowingHandler(req, res) {
  const data = returnEquipmentSchema.parse(req.body);

  const result = await returnBorrowing(
    req.params.borrowingId,
    req.user.id,
    data
  );

  res.json({
    message: 'Equipment returned successfully',
    ...result,
  });
}
