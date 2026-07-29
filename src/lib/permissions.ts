/** Permisos por rol y sección. FUENTE DE NEGOCIO: reglas_negocio.md §1.7.
 *  Editar ACÁ para cambiar accesos. Hay un espejo en
 *  front-dashboard/src/lib/permissions.ts — mantener ambos sincronizados. */

export type Role = "admin" | "manager" | "operator" | "sales" | "accountant";
export type Capability = "view" | "edit" | "manage"; // manage = crear + archivar
export type Section =
  | "agenda"
  | "facturacion"
  | "crm"
  | "catalogo"
  | "proveedoras"
  | "sitio-web"
  | "config-local"
  | "usuarios"
  | "permisos";

export const PERMISSIONS: Record<Section, Record<Capability, Role[]>> = {
  agenda: {
    view: ["admin", "manager", "operator"],
    edit: ["admin", "manager", "operator"],
    manage: ["admin", "manager", "operator"],
  },
  facturacion: {
    view: ["admin", "manager", "operator", "accountant"],
    edit: ["admin", "manager", "operator"],
    manage: ["admin", "manager"],
  },
  crm: {
    view: ["admin", "manager", "operator", "sales"],
    edit: ["admin", "manager", "operator", "sales"],
    manage: ["admin"],
  },
  catalogo: {
    view: ["admin", "manager", "operator"],
    edit: ["admin", "manager", "operator"],
    manage: ["admin", "manager"],
  },
  proveedoras: {
    view: ["admin", "manager"],
    edit: ["admin", "manager"],
    manage: ["admin", "manager"],
  },
  "sitio-web": {
    view: ["admin", "manager", "operator"],
    edit: ["admin", "manager", "operator"],
    manage: ["admin", "manager"],
  },
  "config-local": { view: ["admin"], edit: ["admin"], manage: ["admin"] },
  usuarios: { view: ["admin"], edit: ["admin"], manage: ["admin"] },
  permisos: { view: ["admin"], edit: [], manage: [] },
};

export function can(
  role: Role | null | undefined,
  section: Section,
  cap: Capability,
): boolean {
  if (!role) return false;
  return PERMISSIONS[section][cap].includes(role as Role);
}
