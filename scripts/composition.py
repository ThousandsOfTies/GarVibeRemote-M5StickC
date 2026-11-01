"""Load the Product's pinned composition engine; never access a device on import."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'product.json').read_text(encoding='utf-8'))
sys.path.insert(0, str(ROOT / manifest['components']['tools'] / 'composition'))
from product import Product


def product():
    return Product(ROOT).validate()
