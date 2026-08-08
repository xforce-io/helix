from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest

WORKERS = pathlib.Path(__file__).parents[1] / "workers"


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, WORKERS / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


bridge = load("bridge_worker")
kernel = load("kernel_worker")


class ActionPolicyTest(unittest.TestCase):
    def test_public_program_is_allowed(self) -> None:
        bridge.validate_action(
            "pos = nearest(Resource.IronOre)\n"
            "move_to(pos)\n"
            "print(hasattr(pos, 'x'))\n"
        )

    def test_unknown_public_call_is_recoverable(self) -> None:
        with self.assertRaisesRegex(ValueError, "ACTION_CALL_NOT_ALLOWED"):
            bridge.validate_action("describe_patch(Resource.IronOre)")

    def test_dynamic_execution_is_terminal_policy_violation(self) -> None:
        with self.assertRaisesRegex(ValueError, "POLICY_VIOLATION"):
            bridge.validate_action("describe_patch(Resource.IronOre)\neval('1')")

    def test_private_attribute_and_size_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "POLICY_VIOLATION"):
            bridge.validate_action("print(entity.__class__)")
        with self.assertRaisesRegex(ValueError, "ACTION_TOO_LARGE"):
            bridge.validate_action("#" * 10_001)

    def test_dynamic_builtin_and_callable_bypasses_are_rejected(self) -> None:
        programs = (
            '__builtins__["__import__"]("os").system("id")',
            '__builtins__["open"]("/etc/passwd").read()',
            '(lambda: print("dynamic"))()',
        )
        for program in programs:
            with self.subTest(program=program):
                with self.assertRaisesRegex(ValueError, "POLICY_VIOLATION"):
                    bridge.validate_action(program)
        with self.assertRaisesRegex(ValueError, "ACTION_CALL_NOT_ALLOWED"):
            bridge.validate_action('nearest(Resource.IronOre).public_method()')

    def test_step_exception_is_uncertain_but_validation_is_unchanged(self) -> None:
        self.assertEqual(
            bridge.classify_error(ValueError("POLICY_VIOLATION: blocked"), "step", False),
            ("POLICY_VIOLATION", "unchanged"),
        )
        self.assertEqual(
            bridge.classify_error(RuntimeError("connection dropped"), "step", True),
            ("FLE_EXECUTION_ERROR", "uncertain"),
        )

    def test_command_ledger_returns_completed_result_without_reexecution(self) -> None:
        ledger = bridge.CommandLedger()
        calls = 0

        def execute():
            nonlocal calls
            calls += 1
            return {"ok": True, "result": {"tick": 60}}

        first = ledger.execute("episode:1", "same-input", execute)
        second = ledger.execute("episode:1", "same-input", execute)
        self.assertEqual(first, second)
        self.assertEqual(calls, 1)
        with self.assertRaisesRegex(ValueError, "COMMAND_ID_CONFLICT"):
            ledger.execute("episode:1", "different-input", execute)


class KernelContractTest(unittest.TestCase):
    def test_outer_cell_boundary(self) -> None:
        kernel.validate_cell("result = factorio.reset()")
        with self.assertRaisesRegex(ValueError, "POLICY_VIOLATION"):
            kernel.validate_cell("import os")

    def test_effect_result_supports_mapping_access(self) -> None:
        result = kernel.EffectResult(
            method="reset",
            observation={"score": 1},
            refs={"state": "sha256:x"},
            metrics={"tick": 0},
        )
        self.assertEqual(result.get("observation"), {"score": 1})
        self.assertEqual(result["metrics"], {"tick": 0})

    def test_ipython_and_dynamic_builtins_are_rejected(self) -> None:
        for source in (
            'get_ipython().system("id")',
            '__builtins__["__import__"]("os").system("id")',
            '__builtins__["open"]("/etc/passwd").read()',
        ):
            with self.subTest(source=source):
                with self.assertRaisesRegex(ValueError, "POLICY_VIOLATION"):
                    kernel.validate_cell(source)

    def test_output_buffer_never_retains_more_than_the_preview_limit(self) -> None:
        output = kernel.BoundedTextBuffer(8)
        output.write("123456")
        output.write("789012345")
        self.assertEqual(output.getvalue(), "12345678")
        self.assertTrue(output.truncated)

    def test_resource_limits_are_explicit_and_positive(self) -> None:
        limits = kernel.resource_limits_from_environment(
            {
                "HELIX_KERNEL_MEMORY_BYTES": "1073741824",
                "HELIX_KERNEL_CPU_SECONDS": "600",
            }
        )
        self.assertEqual(limits, (1073741824, 600))
        with self.assertRaisesRegex(ValueError, "positive integer"):
            kernel.resource_limits_from_environment(
                {"HELIX_KERNEL_MEMORY_BYTES": "0", "HELIX_KERNEL_CPU_SECONDS": "600"}
            )


if __name__ == "__main__":
    unittest.main()
