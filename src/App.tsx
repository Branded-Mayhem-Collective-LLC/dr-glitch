import { Route, Routes } from "react-router";
import SessionBadge from "./auth/SessionBadge";
import Login from "./routes/Login";
import Signup from "./routes/Signup";
import HalftoneStudio from "./studio/HalftoneStudio";

export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <>
            <HalftoneStudio />
            <SessionBadge />
          </>
        }
      />
      <Route path="/signup" element={<Signup />} />
      <Route path="/login" element={<Login />} />
    </Routes>
  );
}
