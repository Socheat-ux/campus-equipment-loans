import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext.jsx";
import Login from "./pages/Login.jsx";
import Signup from "./pages/Signup.jsx";
import HomePage from "./pages/HomePage.jsx";
import AdminOnlyPage from "./pages/AdminPageOnly.jsx";
// guest pages bounce signed-in users to "/", every other page bounces guests to "/login"
function Gate({ guest = false, children }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="center-note">Loading</p>;
  if (guest) return user ? <Navigate to="/" replace /> : children;
  return user ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/admin" element={<Gate><AdminOnlyPage /></Gate>} />
      <Route path="/my-requests" element={<Gate><AdminOnlyPage /></Gate>} />
      <Route path="/history" element={<Gate><AdminOnlyPage /></Gate>} />
      <Route path="/login" element={<Gate guest><Login /></Gate>} />
      <Route path="/signup" element={<Gate guest><Signup /></Gate>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
