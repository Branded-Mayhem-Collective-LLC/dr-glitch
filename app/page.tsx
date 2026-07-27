import type { Metadata } from "next";
import HalftoneStudio from "./components/HalftoneStudio";

export const metadata: Metadata = {
  title: "DRC Halftone — CMYK Studio",
  description:
    "Build and export production-ready CMYK halftone separations in your browser.",
  other: {
    "theme-color": "#17191c",
  },
};

export default function Home() {
  return <HalftoneStudio />;
}
