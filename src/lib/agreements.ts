/** Reconciliación de acuerdos proveedora↔servicio (`service_provider_service`).
 *
 *  Regla §4 (vigencias): cambiar la tarifa/tipo de un acuerdo NO es un UPDATE del
 *  registro vigente. Se cierra el viejo (is_active=false + valid_until) y se crea
 *  uno nuevo, para que el pasado quede auditable. Esta función decide qué hacer
 *  comparando el estado actual con el deseado; es pura para poder testearla. */

export type AgreementInput = {
  serviceProviderId: string;
  paymentType: string | null;
  rate: number | null;
};

export type CurrentAgreement = {
  serviceProviderId: string;
  paymentType: string | null;
  rate: number | null;
};

export type AgreementDiff = {
  /** Acuerdos a dar de alta (proveedoras nuevas o con tarifa/tipo cambiado). */
  toCreate: AgreementInput[];
  /** Proveedoras cuyo acuerdo vigente hay que cerrar (quitadas o cambiadas). */
  toCloseProviderIds: string[];
};

export function diffAgreements(
  current: CurrentAgreement[],
  desired: AgreementInput[],
): AgreementDiff {
  const currentByProvider = new Map(current.map((c) => [c.serviceProviderId, c]));
  const desiredProviderIds = new Set(desired.map((d) => d.serviceProviderId));

  const toCreate: AgreementInput[] = [];
  const toCloseProviderIds: string[] = [];

  for (const d of desired) {
    const cur = currentByProvider.get(d.serviceProviderId);
    if (!cur) {
      toCreate.push(d); // proveedora nueva
    } else if (cur.paymentType !== d.paymentType || cur.rate !== d.rate) {
      // cambió la tarifa/tipo → cerrar el viejo y crear uno nuevo (§4)
      toCloseProviderIds.push(d.serviceProviderId);
      toCreate.push(d);
    }
    // sin cambios → no se toca
  }

  for (const c of current) {
    if (!desiredProviderIds.has(c.serviceProviderId)) {
      toCloseProviderIds.push(c.serviceProviderId); // proveedora quitada
    }
  }

  return { toCreate, toCloseProviderIds };
}
