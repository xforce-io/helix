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
    def test_experiment_profile_selects_registered_task_and_slot(self) -> None:
        profile = {"inputRef": "factorio.throughput/iron-plate/v1", "taskId": "iron_plate_throughput", "slot": 0, "seed": 0, "digest": "sha256:test"}
        self.assertEqual(bridge.experiment_task_and_slot({"experimentProfile": profile}), ("iron_plate_throughput", 0))
        with self.assertRaisesRegex(ValueError, "EXPERIMENT_PROFILE_INVALID"):
            bridge.experiment_task_and_slot({"experimentProfile": {**profile, "taskId": "iron_ore_throughput"}})

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


class RecursiveModelBindingTest(unittest.TestCase):
    def test_result_from_wire_normalizes_fields(self) -> None:
        result = kernel.RecursiveModelResult.from_wire(
            {
                "status": "succeeded",
                "text": "hello",
                "textTruncated": False,
                "childRunId": "run:rmc:0",
                "usage": {"inputTokens": 3, "outputTokens": 5},
                "responseRef": {"hash": "sha256:x"},
                "reservation": {
                    "reservedTokens": 10,
                    "declaredPromptTokens": 4,
                    "declaredCompletionTokens": 6,
                    "requestedCompletionTokens": 2048,
                    "actualUsageTokens": 8,
                    "chargedTokens": 8,
                    "overflowTokens": 0,
                },
                "requestDigest": "sha256:abc",
                "attachFailed": False,
                "error": None,
            }
        )
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.child_run_id, "run:rmc:0")
        self.assertEqual(result.usage, {"input_tokens": 3, "output_tokens": 5})
        self.assertEqual(result.reservation["charged_tokens"], 8)
        self.assertEqual(result.request_digest, "sha256:abc")
        self.assertFalse(result.attach_failed)
        self.assertEqual(result["text"], "hello")

    def test_models_binding_requires_string_instructions(self) -> None:
        gate = kernel.CellEffectGate()
        models = kernel.HelixModelsBinding(gate)
        with self.assertRaises(TypeError):
            models.call(123)  # type: ignore[arg-type]




class RecursiveEffectGateTest(unittest.TestCase):
    def test_admission_reject_does_not_poison_local_effect_gate(self) -> None:
        """B2: illegal models.call then factorio.step must still reach Host."""
        gate = kernel.CellEffectGate()
        models = kernel.HelixModelsBinding(gate)
        factorio = kernel.FactorioBinding(gate)

        frames: list[dict] = []
        responses = iter(
            [
                {
                    "type": "effect_response",
                    "ok": True,
                    "result": {
                        "status": "rejected",
                        "text": "",
                        "textTruncated": False,
                        "childRunId": None,
                        "usage": None,
                        "responseRef": None,
                        "reservation": {
                            "reservedTokens": 0,
                            "declaredPromptTokens": 1,
                            "declaredCompletionTokens": 0,
                            "actualUsageTokens": 0,
                            "chargedTokens": 0,
                            "overflowTokens": 0,
                        },
                        "requestDigest": "sha256:x",
                        "error": {
                            "code": "RECURSIVE_BUDGET_INSUFFICIENT",
                            "message": "pool empty",
                        },
                    },
                },
                {
                    "type": "effect_response",
                    "ok": True,
                    "result": {
                        "observation": {"ok": True},
                        "refs": {},
                        "metrics": {},
                    },
                },
            ]
        )

        def fake_send(frame: dict) -> None:
            frames.append(frame)

        def fake_receive() -> dict:
            return next(responses)

        original_send = kernel.send
        original_receive = kernel.receive
        kernel.send = fake_send  # type: ignore[assignment]
        kernel.receive = fake_receive  # type: ignore[assignment]
        try:
            result = models.call("illegal then step")
            self.assertEqual(result.status, "rejected")
            self.assertEqual(gate.effect_count, 0)
            step = factorio.step("print(1)")
            self.assertEqual(step.observation, {"ok": True})
            self.assertEqual(gate.effect_count, 1)
            self.assertEqual(frames[0]["method"], "models.call")
            self.assertEqual(frames[1]["method"], "step")
        finally:
            kernel.send = original_send  # type: ignore[assignment]
            kernel.receive = original_receive  # type: ignore[assignment]

    def test_succeeded_models_call_notes_local_effect_gate(self) -> None:
        gate = kernel.CellEffectGate()
        models = kernel.HelixModelsBinding(gate)
        responses = iter(
            [
                {
                    "type": "effect_response",
                    "ok": True,
                    "result": {
                        "status": "succeeded",
                        "text": "ok",
                        "textTruncated": False,
                        "childRunId": "run:rmc:0",
                        "usage": {"inputTokens": 1, "outputTokens": 1},
                        "responseRef": {"hash": "sha256:r"},
                        "reservation": {
                            "reservedTokens": 10,
                            "declaredPromptTokens": 4,
                            "declaredCompletionTokens": 6,
                            "actualUsageTokens": 2,
                            "chargedTokens": 2,
                            "overflowTokens": 0,
                        },
                        "requestDigest": "sha256:x",
                        "error": None,
                    },
                }
            ]
        )
        original_send = kernel.send
        original_receive = kernel.receive
        kernel.send = lambda frame: None  # type: ignore[assignment]
        kernel.receive = lambda: next(responses)  # type: ignore[assignment]
        try:
            result = models.call("ok")
            self.assertEqual(result.status, "succeeded")
            self.assertEqual(gate.effect_count, 1)
        finally:
            kernel.send = original_send  # type: ignore[assignment]
            kernel.receive = original_receive  # type: ignore[assignment]


if __name__ == "__main__":
    unittest.main()
