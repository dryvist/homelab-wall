export function assignModelColors(models, palette) {
  return models.map((model, index) => ({ ...model, color: palette[index] }));
}
