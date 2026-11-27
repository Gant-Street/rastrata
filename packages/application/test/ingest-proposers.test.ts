import { afterEach, expect, test } from "bun:test";
import type { Proposer } from "../src/ingest-types.ts";
import {
  proposerRegistryVersion,
  registerProposer,
  registeredProposers,
  type ProposerRegistration,
} from "../src/slices/ingest/proposers.ts";

const undo: (() => void)[] = [];
afterEach(() => {
  for (const work of undo.splice(0).reverse()) work();
});

const proposer = (name: string): Proposer => ({ name, propose: () => [] });
const registration = (name: string): ProposerRegistration => ({
  name,
  create: () => proposer(name),
});

test("proposers are listed in name order whatever order they registered in", () => {
  const mine = ["zeta", "alpha", "mid.dle"];
  for (const name of mine) undo.push(registerProposer(registration(name)));
  // Other registrations (the built-in matchers) may be present; theirs sort in among them.
  const names = registeredProposers().map((item) => item.name);
  expect(names).toEqual([...names].sort());
  expect(names.filter((name) => mine.includes(name))).toEqual(["alpha", "mid.dle", "zeta"]);
});

test("a name can only be taken once, but the same registration is harmless", () => {
  const first = registration("example.rules");
  undo.push(registerProposer(first));
  const before = proposerRegistryVersion();
  registerProposer(first);
  expect(proposerRegistryVersion()).toBe(before);
  expect(() => registerProposer(registration("example.rules"))).toThrow(/already registered/);
  expect(registeredProposers().filter((item) => item.name === "example.rules")).toHaveLength(1);
});

test("registering and removing a proposer changes the registry version", () => {
  const start = proposerRegistryVersion();
  const remove = registerProposer(registration("example.classifier"));
  expect(proposerRegistryVersion()).toBe(start + 1);
  remove();
  expect(proposerRegistryVersion()).toBe(start + 2);
  remove();
  expect(proposerRegistryVersion()).toBe(start + 2);
  expect(registeredProposers().some((item) => item.name === "example.classifier")).toBe(false);
});

test("a stale remover never removes a newer registration under the same name", () => {
  const first = registration("example.stripe");
  const removeFirst = registerProposer(first);
  removeFirst();
  const second = registration("example.stripe");
  undo.push(registerProposer(second));
  removeFirst();
  expect(registeredProposers().find((item) => item.name === "example.stripe")).toBe(second);
});

test("names that could be confused with something else are refused", () => {
  for (const name of ["", "Rules", "1rules", "rules engine", "rules/x", "a".repeat(65)])
    expect(() => registerProposer(registration(name))).toThrow(/names are lower case/);
  expect(() => registerProposer({ name: "broken" } as unknown as ProposerRegistration)).toThrow(
    /create function/,
  );
});
