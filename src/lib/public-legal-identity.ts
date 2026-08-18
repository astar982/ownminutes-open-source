export type PublicLegalIdentity = {
  operatorAddress: string;
  operatorName: string;
  jurisdiction: string;
};

export function getPublicLegalIdentity(): PublicLegalIdentity | null {
  const operatorName = normalize(process.env.OWNMINUTES_LEGAL_OPERATOR_NAME);
  const operatorAddress = normalize(process.env.OWNMINUTES_LEGAL_OPERATOR_ADDRESS);
  const jurisdiction = normalize(process.env.OWNMINUTES_LEGAL_OPERATOR_JURISDICTION);

  if (!operatorName || !operatorAddress || !jurisdiction) return null;

  return {
    operatorAddress,
    operatorName,
    jurisdiction,
  };
}

export function hasCompletePublicLegalIdentity() {
  return getPublicLegalIdentity() !== null;
}

function normalize(value: string | undefined) {
  return value?.trim() || "";
}
