"use client";
import React, { createContext } from "react";

export const CPContext = createContext(null);

export function CPRootProvider({ children }) {
  return <CPContext.Provider value={null}>{children}</CPContext.Provider>;
}
