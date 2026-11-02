import { useEffect, useId, useState } from "react";
import { flushSync } from "react-dom";
import { ErrorText, Field, SelectField } from "../../auth/AuthUI.jsx";
import { EQUIPMENT_CATEGORIES, equipmentInput } from "../../../server/rules.js";
import { CloseIcon } from "../Icons.jsx";

export default function EquipmentDrawer({ mode, item, onClose, onSave }) {
  const editing = mode === "edit";
  const [name, setName] = useState(item?.name ?? "");
  const [category, setCategory] = useState(item?.category ?? "");
  const [quantity, setQuantity] = useState(item ? String(item.quantity) : "");
  const [fields, setFields] = useState({});
  const [error, setError] = useState("");
  const errorId = useId();
  const shown = error ? errorId : undefined;

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function submit(event) {
    event.preventDefault();
    flushSync(() => {
      setError("");
      setFields({});
    });
    const check = equipmentInput({ name, category, quantity });
    setFields(check.fields);
    if (Object.keys(check.fields).length) return setError("Please fix the fields below.");
    onSave(check.value, mode);
  }

  return (
    <div className="dash-drawer-backdrop" onMouseDown={onClose}>
      <aside
        className="dash-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="equipment-drawer-title"
        aria-describedby="equipment-drawer-desc"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dash-drawer-head">
          <div>
            <h2 id="equipment-drawer-title">{editing ? "Edit equipment" : "Add equipment"}</h2>
            <p id="equipment-drawer-desc">
              {editing
                ? "Update the record and available quantity. Changes appear in the catalogue immediately."
                : "Add a new item to the university equipment catalogue."}
            </p>
          </div>
          <button type="button" className="dash-drawer-close" aria-label="Close" onClick={onClose}>
            <CloseIcon size={19} />
          </button>
        </div>

        <form className="dash-drawer-form" onSubmit={submit} noValidate>
          <div className="dash-drawer-body">
            <Field
              label="Equipment name"
              name="name"
              autoFocus
              errorId={shown}
              error={fields.name}
              hint="Use the name students and staff will search for."
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <SelectField
              label="Category"
              name="category"
              errorId={shown}
              error={fields.category}
              hint="Choose the closest category."
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="">Select a category</option>
              {EQUIPMENT_CATEGORIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </SelectField>
            <Field
              label="Quantity"
              name="quantity"
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              errorId={shown}
              error={fields.quantity}
              hint="Quantity must be 0 or more."
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
            <ErrorText id={errorId}>{error}</ErrorText>
          </div>

          <div className="dash-drawer-foot">
            <button type="button" className="btn-outline" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary dash-save-btn">
              {editing ? "Save changes" : "Add equipment"}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
