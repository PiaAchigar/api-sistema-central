import { describe, expect, it } from "vitest";
import { faqBody } from "./automation-faqs.schema";

const base = {
  question: "¿Hasta qué hora atienden?",
  answer: "L-V de 9 a 20",
  keywords: ["hora", "horario", "abren"],
};

describe("faqBody", () => {
  it("acepta una FAQ válida", () => {
    expect(faqBody.safeParse(base).success).toBe(true);
  });
  it("acepta sin question (es opcional)", () => {
    const { question: _question, ...rest } = base;
    expect(faqBody.safeParse(rest).success).toBe(true);
  });
  it("rechaza answer vacío", () => {
    expect(faqBody.safeParse({ ...base, answer: "" }).success).toBe(false);
  });
  it("rechaza keywords vacío", () => {
    expect(faqBody.safeParse({ ...base, keywords: [] }).success).toBe(false);
  });
  it("rechaza una keyword vacía dentro del array", () => {
    expect(
      faqBody.safeParse({ ...base, keywords: ["hora", ""] }).success
    ).toBe(false);
  });
});
