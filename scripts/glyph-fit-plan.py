"""Print glyph fitting inputs from the catalog (no copied design values)."""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def glyph_plan():
    base = json.loads((ROOT / 'token_catalog/00-foundations.tokens.json').read_text())
    source = json.loads((ROOT / 'token_catalog/01-primitives.tokens.json').read_text())
    icon = source['primitives']['shared']['icon']
    token = icon['artwork-coverage']
    path = token['$value'].strip('{}')
    resolved = base
    for part in path.split('.'):
        resolved = resolved[part]
    policy = icon['$extensions']['app.caelos']['artworkSizing']
    return dict(**policy['figmaScope'], intrinsicGlyphs=policy['intrinsicGlyphs'],
                coverage=resolved['$value'], foundationName=resolved['$extensions']['app.caelos']['figmaName'],
                primitiveName='primitives/shared/icon/artwork-coverage')
if __name__ == '__main__':
    print(json.dumps(glyph_plan()))
