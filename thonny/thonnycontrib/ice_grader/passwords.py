"""The grader password and the Gemini key, kept in the computer's own password store (Windows Credential Manager,
the macOS Keychain, or the Linux Secret Service) through the keyring library - never in a file. If there is no
store, nothing is kept and the plug-in asks again next time."""
import logging

SERVICE = "thonny-ice-grader"
logger = logging.getLogger(__name__)


class KeyringSecrets:
    def get(self, name):
        try:
            import keyring
            return keyring.get_password(SERVICE, name)
        except Exception:  # noqa: BLE001 - no keyring, or no store on this computer
            logger.info("ICE Grader: password store not available", exc_info=True)
            return None

    def set(self, name, value):
        """-> True if it was kept"""
        try:
            import keyring
            keyring.set_password(SERVICE, name, value)
            return True
        except Exception:  # noqa: BLE001
            logger.info("ICE Grader: password store not available", exc_info=True)
            return False

    def delete(self, name):
        try:
            import keyring
            keyring.delete_password(SERVICE, name)
        except Exception:  # noqa: BLE001 - not there, or no store
            pass


class MemorySecrets:
    """For tests, and a stand-in that keeps nothing after Thonny closes."""

    def __init__(self):
        self.values = {}

    def get(self, name):
        return self.values.get(name)

    def set(self, name, value):
        self.values[name] = value
        return True

    def delete(self, name):
        self.values.pop(name, None)
