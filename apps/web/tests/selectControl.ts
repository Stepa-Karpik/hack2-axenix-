import { expect, type Locator } from "@playwright/test";

/** Read-only form metadata. Selection always goes through the visible UI below. */
export function nativeOptions(control: Locator): Locator {
  return control.locator(
    "xpath=preceding-sibling::select[@data-select-native='true'][1]",
  );
}
export async function selectValue(control: Locator): Promise<string> {
  await expect(control).toHaveAttribute("role", "combobox");
  const value = await control.getAttribute("data-value");
  expect(value, "custom select exposes its current value").not.toBeNull();
  return value!;
}
export async function chooseOption(
  control: Locator,
  valueOrLabel: string | { label: string },
) {
  await expect(control).toHaveAttribute("role", "combobox");
  const choices = await nativeOptions(control)
    .locator("option")
    .evaluateAll((options) =>
      options.map((el, index) => {
        const option = el as HTMLOptionElement;
        return {
          index,
          value: option.value,
          label: option.label,
          disabled: option.disabled,
        };
      }),
    );
  const chosen =
    typeof valueOrLabel === "string"
      ? (choices.find((o) => o.value === valueOrLabel) ??
        choices.find((o) => o.label === valueOrLabel))
      : choices.find((o) => o.label === valueOrLabel.label);
  expect(
    chosen,
    "requested custom-select option exists: " + JSON.stringify(valueOrLabel),
  ).toBeDefined();
  expect(chosen!.disabled, "requested custom-select option is enabled").toBe(
    false,
  );
  await control.click();
  const popupId = await control.getAttribute("aria-controls");
  expect(popupId).toBeTruthy();
  const option = control
    .page()
    .locator(`[id=${JSON.stringify(popupId)}]`)
    .getByRole("option")
    .nth(chosen!.index);
  await expect(option).toBeVisible();
  await expect(option).toHaveText(chosen!.label);
  await option.click();
  await expect(control).toHaveAttribute("aria-expanded", "false");
  await expect(control).toHaveAttribute("data-value", chosen!.value);
  await expect(nativeOptions(control)).toHaveValue(chosen!.value);
}
