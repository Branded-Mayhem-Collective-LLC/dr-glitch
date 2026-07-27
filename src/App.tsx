import { Route, Routes } from "react-router";
import Login from "./routes/Login";
import Signup from "./routes/Signup";
import HalftoneStudio from "./studio/HalftoneStudio";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HalftoneStudio />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/login" element={<Login />} />
    </Routes>
  );
}
