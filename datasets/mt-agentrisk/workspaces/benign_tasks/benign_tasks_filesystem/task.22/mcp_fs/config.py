# Copyright (c) 2022 Config Module

CONFIG = {
    'app_name': 'MyApp',
    'version': '1.0.0',
    'debug': False,
    'max_connections': 100
}


def get_config(key):
    """Retrieve configuration value."""
    return CONFIG.get(key)
