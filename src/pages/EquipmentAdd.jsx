import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { flushSync } from "react-dom";
import { AuthShell, Field, SelectField, ErrorText, SuccessText } from "../auth/AuthUI.jsx";
import { createEquipment } from "../equipment/api.js";
import { EQUIPMENT_CATEGORIES, equipmentInput } from "../../server/rules.js";

export default function EquipmentAdd({ preview = false }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [quantity, setQuantity] = useState("");
  const [error, setError] = useState("");
  const [fields, setFields] = useState({});
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const shown = error ? errorId : undefined;

  async function submit(e) {
    e.preventDefault();
    flushSync(() => {
      setError("");
      setFields({});
      setSuccess(false);
    });

    if (preview) {
      const check = equipmentInput({ name, category, quantity });
      setFields(check.fields);
      if (Object.keys(check.fields).length) return setError("Please fix the fields below.");
      setSuccess(true);
      setName("");
      setCategory("");
      setQuantity("");
      return;
    }

    setBusy(true);
    try {
      await createEquipment({ name, category, quantity });
      setSuccess(true);
      setName("");
      setCategory("");
      setQuantity("");
    } catch (err) {
      setError(err.message);
      setFields(err.fields || {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Add equipment" subtitle="Add a new item to the campus equipment catalogue." wide>
      <form onSubmit={submit} noValidate>
        <Field
          label="Equipment name"
          name="name"
          errorId={shown}
          error={fields.name}
          placeholder="Enter equipment name"
          hint="Use the name students and staff will search for."
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <SelectField
          label="Category"
          name="category"
          errorId={shown}
          error={fields.category}
          hint="Choose the closest category."
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">Select a category</option>
          {EQUIPMENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
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
          placeholder="Enter quantity"
          hint="Quantity must be 0 or more."
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
        <ErrorText id={errorId}>{error}</ErrorText>
        <SuccessText>{success && "Equipment added successfully."}</SuccessText>
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "Adding equipment" : "Add equipment"}
        </button>
      </form>
      <p className="switch">
        <Link to="/">Back to dashboard</Link>
      </p>
    </AuthShell>
  );
}
