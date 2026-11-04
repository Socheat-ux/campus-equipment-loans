import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import HomePage from "./pages/HomePage.jsx";
import EquipmentAdd from "./pages/EquipmentAdd.jsx";
import EquipmentEdit from "./pages/EquipmentEdit.jsx";
import EquipmentDashboard from "./pages/EquipmentDashboard.jsx";
import { PREVIEW_EQUIPMENT, PREVIEW_USER } from "./equipment/previewData.js";

// guest pages bounce signed-in users to the catalogue, every other page bounces guests to "/login"
function Gate({ guest = false, children }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="center-note">Loading</p>;
  if (guest) return user ? <Navigate to="/" replace /> : children;
  return user ? children : <Navigate to="/login" replace />;
}

// Administrator-only pages; everyone else goes back to the dashboard.
function AdminGate({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="center-note">Loading</p>;
  if (!user) return <Navigate to="/login" replace />;
  return user.role === "admin" ? children : <Navigate to="/dashboard" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/login" element={<Gate guest><Login /></Gate>} />
      <Route path="/signup" element={<Gate guest><Signup /></Gate>} />
      <Route path="/dashboard" element={<Gate><EquipmentDashboard /></Gate>} />
      <Route path="/equipment" element={<Navigate to="/dashboard" replace />} />
      <Route path="/equipment/new" element={<AdminGate><EquipmentAdd /></AdminGate>} />
      <Route path="/equipment/:id/edit" element={<AdminGate><EquipmentEdit /></AdminGate>} />
      {/* Design previews, development only: no login, database, or API needed. */}
      {import.meta.env.DEV && <Route path="/preview/equipment/new" element={<EquipmentAdd preview />} />}
      {import.meta.env.DEV && <Route path="/preview/equipment/edit" element={<EquipmentEdit preview />} />}
      {import.meta.env.DEV && (
        <Route
          path="/preview/equipment"
          element={
            <EquipmentDashboard
              initialEquipment={PREVIEW_EQUIPMENT}
              user={PREVIEW_USER}
              onLogout={() => {}}
            />
          }
        />
      )}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
