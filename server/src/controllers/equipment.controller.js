import {
  listEquipment,
  getEquipmentById,
  createEquipment,
  updateEquipment,
  deleteEquipment,
} from '../services/equipment.service.js';

import {
  equipmentQuerySchema,
  createEquipmentSchema,
  updateEquipmentSchema,
} from '../validators/equipment.validator.js';


export async function getEquipment(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
  const search = req.query.search?.trim();

  const { equipment, total } = await listEquipment({
  page,
  limit,
  search,
});

res.json({
  message: 'Equipment retrieved successfully',
  data: equipment,
  pagination: {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  },
});
}

export async function getEquipmentDetail(req, res) {
  const equipment = await getEquipmentById(req.params.id);

  if (!equipment) {
    return res.status(404).json({ error: 'Equipment not found' });
  }

  res.json(equipment);
}

export async function createEquipmentHandler(req, res) {
  const data = createEquipmentSchema.parse(req.body);
  const equipment = await createEquipment(data);

  res.status(201).json({
    message: 'Equipment created successfully',
    equipment,
  });
}

export async function updateEquipmentHandler(req, res) {
  const data = updateEquipmentSchema.parse(req.body);
  const equipment = await updateEquipment(req.params.id, data);

  res.json({
    message: 'Equipment updated successfully',
    equipment,
  });
}

export async function deleteEquipmentHandler(req, res) {
  await deleteEquipment(req.params.id);

  res.json({ message: 'Equipment deleted successfully' });
}