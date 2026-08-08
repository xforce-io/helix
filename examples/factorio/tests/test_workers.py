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


if __name__ == "__main__":
    unittest.main()
