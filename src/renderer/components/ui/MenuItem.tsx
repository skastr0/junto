import type { ComponentPropsWithRef } from "react";
import "./menu-item.css";

/**
 * One row of a menu: a button with the menu role, the house 28px target, the
 * overlay tint and the inset focus ring. The caller owns the roving tabindex
 * and the menu's keys (role menuitemradio and tabIndex pass through).
 */
export function MenuItem({ className, type = "button", role = "menuitem", ...rest }: ComponentPropsWithRef<"button">) {
  return <button {...rest} type={type} role={role} className={className ? `menu-item ${className}` : "menu-item"} />;
}
