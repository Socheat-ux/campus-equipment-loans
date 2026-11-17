import { useEffect, useId, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { flushSync } from "react-dom";
import { AuthShell, Field, SelectField, ErrorText, SuccessText } from "../auth/AuthUI.jsx";
import { getEquipment, updateEquipment } from "../equipment/api.js";
import { EQUIPMENT_CATEGORIES, equipmentInput } from "../../server/rules.js";

export default function EquipmentEdit({ preview = false }) {
  const { id } = useParams();
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [quantity, setQuantity] = useState("");
  const [error, setError] = useState("");
  const [fields, setFields] = useState({});
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const shown = error ? errorId : undefined;

  useEffect(() => {
    if (preview) {
      setName("Dell XPS 13 laptop");
      setCategory("Laptop");
      setQuantity("5");
      setLoaded(true);
      return;
    }
    let live = true;
    getEquipment(id)
      .then((item) => {
        if (!live) return;
        setName(item.name);
        setCategory(item.category);
        setQuantity(String(item.quantity));
        setLoaded(true);
      })
      .catch((err) => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [id, preview]);

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
      return;
    }

    setBusy(true);
    try {
      const item = await updateEquipment(id, { name, category, quantity });
      setName(item.name);
      setQuantity(String(item.quantity));
      setSuccess(true);
    } catch (err) {
      setError(err.message);
      setFields(err.fields || {});
    } finally {
      setBusy(false);
    }
  }

  if (!loaded && error) {
    return (
      <AuthShell title="Edit equipment" subtitle="Update an item in the campus equipment catalogue." wide>
        <ErrorText id={errorId}>{error}</ErrorText>
        <p className="switch">
          <Link to="/">Back to dashboard</Link>
        </p>
      </AuthShell>
    );
  }

  if (!loaded) {
    return (
      <AuthShell title="Edit equipment" subtitle="Update an item in the campus equipment catalogue." wide>
        <p className="hint">Loading equipment…</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Edit equipment" subtitle="Update an item in the campus equipment catalogue." wide>
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
        <SuccessText>{success && "Changes saved."}</SuccessText>
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? "Saving changes" : "Save changes"}
        </button>
      </form>
      <p className="switch">
        <Link to="/">Cancel</Link>
      </p>
    </AuthShell>
  );
}
