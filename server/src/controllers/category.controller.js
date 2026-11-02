import {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
} from '../services/category.service.js';

import {
  createCategorySchema,
  updateCategorySchema,
} from '../validators/category.validator.js';

export async function getCategories(req, res) {
  const categories = await getAllCategories();
  res.json(categories);
}

export async function getCategory(req, res) {
  const category = await getCategoryById(req.params.id);

  if (!category) {
    return res.status(404).json({ error: 'Category not found' });
  }

  res.json(category);
}

export async function createCategoryHandler(req, res) {
  const data = createCategorySchema.parse(req.body);
  const category = await createCategory(data);

  res.status(201).json({
    message: 'Category created successfully',
    category,
  });
}

export async function updateCategoryHandler(req, res) {
  const data = updateCategorySchema.parse(req.body);
  const category = await updateCategory(req.params.id, data);

  res.json({
    message: 'Category updated successfully',
    category,
  });
}

export async function deleteCategoryHandler(req, res) {
  await deleteCategory(req.params.id);

  res.json({ message: 'Category deleted successfully' });
}