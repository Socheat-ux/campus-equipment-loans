import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth/AuthContext.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import HomePage from "./pages/HomePage.jsx";
import EquipmentAdd from "./pages/EquipmentAdd.jsx";
import EquipmentEdit from "./pages/EquipmentEdit.jsx";
import EquipmentDashboard from "./pages/EquipmentDashboard.jsx";
import { PREVIEW_EQUIPMENT, PREVIEW_USER } from "./equipment/previewData.js";
import NotAllowedPage from "./pages/NotAllowedPage.jsx";
import { access } from "./auth/access.js";

// Guest-only pages (log in, sign up) bounce signed-in users to the catalogue.
function Gate({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="center-note">Loading</p>;
  return user ? <Navigate to="/" replace /> : children;
}

// Pages for some roles only: guests go to the login page, other roles see "not allowed".
// `page` names the page in that message, for example "The equipment dashboard".
// The browser check only decides what to show; the API enforces the same rule with requireRole.
function RoleGate({ roles, page, children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="center-note">Loading</p>;
  const result = access(user, roles);
  // Remember the page, so signing in leads straight back to it.
  if (result === "login") return <Navigate to="/login" replace state={{ from: location.pathname + location.search + location.hash }} />;
  // Keyed by path, so moving between two blocked pages remounts it and announces the new page again.
  return result === "ok" ? children : <NotAllowedPage key={location.pathname} roles={roles} page={page} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/login" element={<Gate><Login /></Gate>} />
      <Route path="/signup" element={<Gate><Signup /></Gate>} />
      <Route path="/dashboard" element={<RoleGate roles={["admin"]} page="The equipment dashboard"><EquipmentDashboard /></RoleGate>} />
      <Route path="/equipment" element={<Navigate to="/dashboard" replace />} />
      <Route path="/equipment/new" element={<RoleGate roles={["admin"]} page="Adding equipment"><EquipmentAdd /></RoleGate>} />
      <Route path="/equipment/:id/edit" element={<RoleGate roles={["admin"]} page="Editing equipment"><EquipmentEdit /></RoleGate>} />
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
