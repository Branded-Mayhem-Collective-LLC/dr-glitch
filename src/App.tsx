import { Route, Routes } from "react-router";
import HalftoneStudio from "./studio/HalftoneStudio";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HalftoneStudio />} />
    </Routes>
  );
}
