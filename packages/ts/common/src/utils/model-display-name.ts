export const modelDisplayName: Record<string, string> = {
  "mistral-large-2407": "Mistral Large 2",
  "mistral-large-2411": "Mistral Large 2.1",
  "mistral-large-2411-lasso": "Mistral Large 2.1",
  "mistral-large-2411-lightspeed": "Mistral Large 2.1",
  "pixtral-large-2411": "Pixtral Large",
  "mistral-medium-2505": "Mistral Medium 3",
  "mistral-medium-2505-lightspeed": "Mistral Medium 3",
  "mistral-medium-2508": "Mistral Medium 3.1",
  "mistral-medium-3-5": "Mistral Medium 3.5",
};

export function getModelDisplayName(modelName: string): string {
  const exactDisplayName = modelDisplayName[modelName];
  if (exactDisplayName) return exactDisplayName;

  if (modelName.startsWith("mistral-medium")) return "Mistral Medium";
  if (modelName.startsWith("mistral-small")) return "Mistral Small";
  if (modelName.startsWith("mistral-large")) return "Mistral Large";

  return modelName;
}
