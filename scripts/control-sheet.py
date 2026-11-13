"""Compile Tier 2 review rows from the catalog and known Figma specimens."""
import json
from pathlib import Path
import runpy
import subprocess

ROOT = Path(__file__).resolve().parents[1]
leaves = runpy.run_path(str(ROOT / 'scripts/figma-catalog.py'))['leaves']


def manifest():
    source = json.loads((ROOT / 'token_catalog/02-controls.tokens.json').read_text())
    expanded = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import { resolveControlCatalog } from './src/tier-2/control-catalog.mjs'; import catalog from './token_catalog/02-controls.tokens.json' with {type:'json'}; console.log(JSON.stringify(resolveControlCatalog(catalog)));"], cwd=ROOT))
    shared = source['controls']['$extensions']['app.caelos']['sharedConstruction']
    tables = {}
    for mode in ['dark', 'light']:
        table = {}
        for filename in ['00-foundations.tokens.json', '00-semantic.dark.tokens.json', f'00-semantic.{mode}.tokens.json', '01-primitives.tokens.json', '02-controls.tokens.json']:
            table.update(dict(leaves(json.loads((ROOT / 'token_catalog' / filename).read_text()))))
        tables[mode] = table

    def resolve(path, mode):
        chain = []
        while path not in chain:
            chain.append(path)
            value = tables[mode][path]['$value']
            if not isinstance(value, str) or not value.startswith('{'):
                return value, chain
            path = value[1:-1]
        raise ValueError('Alias cycle: ' + path)

    def ingredient(path):
        token = tables['dark'][path]
        name = token['$extensions']['app.caelos'].get('figmaName', path.replace('.', '/'))
        value, _ = resolve(path, 'dark')
        light, _ = resolve(path, 'light')
        collection = '00 Base' if path.startswith('base.') else '01 Semantic' if path.startswith('sys.') else '02 Control recipes'
        return dict(path=path, name=name, collection=collection, type=token['$type'], value=value, light=light if light != value else None)

    construction_tokens = {}
    for path, token in tables['dark'].items():
        own = ingredient(path)
        target = token['$value'][1:-1] if path.startswith('controls.') else path
        construction_tokens[own['collection'] + '/' + own['name']] = ingredient(target)

    for name, reference in json.loads((ROOT / 'scripts/shared-control-legacy-aliases.json').read_text()).items():
        construction_tokens['02 Control recipes/' + name] = ingredient(reference[1:-1])

    # These names are emitted by src/tier-3/control-preset.mjs, not guessed aliases.
    button_css = {'foreground', 'focus-foreground', 'disabled-foreground', 'bed', 'default', 'hover', 'pressed', 'success', 'disabled-bed', 'tint', 'focus-glow-blur', 'focus-glow-ink', 'focus-glow-opacity'}
    field_css = {'foreground', 'hover-foreground', 'focus-glow-blur', 'focus-glow-ink', 'focus-glow-opacity'}
    recipes = {'button': 'primaryButtonInk() · paint only; complete component wiring remains open', 'input': 'fieldSurface() · cloud, hover and focus surface only; complete input recipe remains open'}
    definitions = [
        ('shared-controls', 'Shared control construction', 'One set of lower-tier ingredients for Buttons, Chips and Badges. Choices name their values. Components select them; these are not extra foundation tokens or coordinated size profiles.'),
        ('buttons', 'Buttons', 'Action emphasis and state comparison. Medium radius is approved; geometry and some state treatments remain draft.'),
        ('fields', 'Fields', 'Text, search and multiline controls. Muted resting/focused field text, dim supporting copy and blue hover text. Cloud wash and field spacing use lower-tier tokens.'),
        ('tabs', 'Tabs', 'Individual tab triggers. Appearance, selection and interaction state are independent; the coordinated container remains Tier 4.'),
        ('chips', 'Chips', 'Interactive filter menus and direct toggles. Cloud at rest, glass when pressed; no Success state.'),
        ('badges', 'Badges', 'Passive status, counts and category labels. Shape and tone vary; no interactive states.'),
        ('avatars', 'Avatars', 'Identity fallback and status. Circle and square are grouped by size; XL and XXL retain their distinct type tokens.'),
        ('indicators', 'Indicators', 'Loading and connection inventory. Entries without a specimen remain explicitly open.'),
        ('triggers', 'Triggers and links', 'Quiet actions and shared control contracts whose complete recipes still need review.'),
        ('composer', 'Composer references', 'Existing composer actions are retained as cross-tier references. Product-unit composition remains Tier 5.'),
    ]
    categories = {key: dict(key=key,title=title,purpose=purpose,column=i%3,y=100,studies=[],rows=[],pending=[]) for i,(key,title,purpose) in enumerate(definitions)}
    def study(key, name, node, axes, note):
        categories[key]['studies'].append(dict(name=name,id=node,splitAxes=axes,note=note))
    for name,node in [('Primary','377:6244'),('Tonal','377:6413'),('Text','377:6426')]:
        study('buttons',name,node,['Motion'],'')
    categories['buttons']['studies'][0]['note'] = (
        'Partial recipe · controls.shared.button\nPanda · ' + recipes['button'] +
        '\nHover = Focus: blue text + soft glow. Pressed: immediate feedback. ✓ Success: confirmed result only; resets on the next edit/eligibility. No timer or click-to-reset.' +
        '\nSurface: cloud/angle + wash-start/end + wash-start/end-alpha. Rest glow: opacity/0.07 + blur/12 + zero offset. Success stays plain for contrast.\nLower-tier geometry; side padding 15px. Prototype wiring partial; press/release and runtime keyboard behavior unverified. Timing provisional.')
    for name in ['Tonal', 'Text']:
        entry = next(s for s in categories['buttons']['studies'] if s['name'] == name)
        entry['note'] = ('Partial recipe · controls.shared.button\nPanda · ' + name.lower() + 'ButtonInk() · surface paint; complete component wiring remains open' +
            '\n6 states. Hover = Focus: blue foreground + soft glow. ✓ Success: confirmed result only; resets on next edit/eligibility. No timer or click-to-reset.' +
            ('\nTranslucent violet/sage wash. Pressed: shared glass, 125% saturation in CSS. Success: sage-green label over quiet sage wash. Figma gradients are sync-derived; saturation/overlap and opaque fallback require runtime review.' if name == 'Tonal' else
             '\nUnfilled in every state. Hover/Focus: blue glyph glow at opacity/0.5. Pressed: cream glyph glow. Success: sage-green check and label.') +
            '\nLower-tier geometry; side padding 15px. State previews; pointer/keyboard prototype wiring unverified. Dark v1; visual approval pending.')
    study('fields','Field','377:6498',['Form'],'Partial recipe · controls.shared.input\nPanda · '+recipes['input']+'\nRest and typing focus · muted / dim. Hover · blue field text.\nDark v1. Prototype links retained; behavior not retested.')
    study('tabs','Tab','377:6625',['Appearance'],'Partial recipe · controls.shared.tabTrigger\nPanda · no complete recipe export\nDark v1 · visual approval pending. Keyboard navigation remains unverified.')
    categories['tabs']['studies'][0].update(lineAxis='Selection', summary='2 selections · 4 states each', sharedConstruction=True)
    study('chips','Chip','474:1024',['Shape'],'Partial recipe · controls.shared.chip\nDefault / Hover / Focus / Pressed / Disabled. Hover = Focus. Menu-open or toggle selection may retain Pressed; applied filter summary is separate. No Success.\nShared cloud / glass primitives; 125% saturation is runtime-only in Figma. Static state specimens; keyboard and menu wiring remain open.\nRounded / pill: filter-menu example. Circle: direct-toggle example; accessible name required.')
    study('badges','Badge','474:1049',['Shape'],'Partial recipe · controls.shared.badge\nPassive information: neutral / info / success / danger. Success is a status, not an action response. No hover, focus, pressed or tab stop. Circle shows a count.\nShared glass + diagonal tone-to-violet wash. 125% background saturation and adaptive overlap are runtime-only. Gradient geometry/alpha are catalog-derived; sync required after token changes. No hard outline. Static review; complete component export remains open.')
    study('avatars','Avatar','377:6793',['Shape','Size'],'Partial recipe · controls.shared.avatar\nInitials, frame sizes, square radii and status sizes are mapped. Complete recipe remains open. No complete Panda export.')
    for node in range(6482,6498):
        study('composer','Action reference','377:'+str(node),[], 'Cross-tier reference · Tier 5 composer\nExisting instance preserved; not promoted to a Tier 2 recipe.')

    uses = {}
    for file in sorted((ROOT/'token_catalog').glob('*.tokens.json')):
        for path,token in leaves(json.loads(file.read_text())):
            value=token['$value']
            if isinstance(value,str) and value.startswith('{'):
                uses.setdefault(value[1:-1],[]).append(path)
    families = {}
    compatibility_exports = []
    for path,token in leaves(source):
        owner=path.split('.')[2]
        category={'button':'buttons','input':'fields','avatar':'avatars','chip':'chips','tabTrigger':'tabs'}[owner]
        meta=token['$extensions']['app.caelos']
        value,chain=resolve(path,'dark');light,light_chain=resolve(path,'light')
        suffix=path.split('.')[-1]
        css=None
        if owner=='button' and suffix in button_css: css='button-'+suffix
        elif owner=='button' and suffix=='glow-offset': css='button-inset'
        elif owner=='input' and ('.cloud.' in path or suffix in field_css): css='field-'+suffix
        label=suffix
        if token['$type']=='color':
            label=(tables['dark'][chain[-1]].get('$extensions',{}).get('app.caelos',{}).get('displayName','')+' · '+suffix).strip(' ·')
        item=dict(path=path,name=meta.get('figmaName',path.replace('.','/')),type=token['$type'],value=value,label=label,status=meta['status'],evidence=meta.get('decision', meta.get('evidence', ', '.join(meta.get('decisions',[])) or 'No decision reference recorded')),uses=uses.get(path,[]),chain=chain[1:],light=light if light!=value else None,lightChain=light_chain[1:] if light!=value else [],description=token.get('$description',''),css='--caelos-material-'+css if css else None)
        item['construction'] = ingredient(chain[1])
        family=' / '.join(path.split('.')[2:-1])
        if owner == 'button':
            compatibility_exports.append(item)  # Paint shown in states; these are CSS compatibility exports, not new choices.
        else:
            families.setdefault((category,family),[]).append(item)
    for (category,name),items in families.items():
        categories[category]['rows'].append(dict(name='Shared construction' if category == 'tabs' else name, items=items, countUnit='parameters'))
    categories['tabs']['studies'][0]['sharedConstructionPaths'] = [i['construction']['path'] for r in categories['tabs']['rows'] for i in r['items']]
    group_map={'button':'buttons','buttonVariants':'buttons','controlSkin':'buttons','IconButton':'buttons','RefreshButton':'buttons','input':'fields','tabTrigger':'tabs','chip':'chips','badge':'badges','DeliveryChip':'badges','avatar':'avatars','rippleLoader':'indicators','NovaLoader':'indicators','Loading':'indicators','ConnectionIndicator':'indicators','quietTrigger':'triggers','recipes-control':'triggers','sidebar-recipe-control':'triggers','Link':'triggers'}
    for scope,group in source['controls'].items():
        if scope.startswith('$'): continue
        for name,entry in group.items():
            if name.startswith('$') or name in ['tabTrigger','button','chip','badge']: continue  # Tab identity and status are already on its study.
            meta=entry['$extensions']['app.caelos']
            categories[group_map[name]]['pending'].append(dict(path=f'controls.{scope}.{name}',name=name,status=meta['status'],description=entry.get('$description',''),variants=meta.get('variants',{}),states=meta.get('states',[]),note=meta.get('note',''),recipe=recipes.get(name)))
    covered=[i['path'] for c in categories.values() for r in c['rows'] for i in r['items']]
    covered += [i['path'] for i in compatibility_exports]
    expected=[p for p,_ in leaves(source)]
    if len(covered)!=len(set(covered)) or set(covered)!=set(expected): raise ValueError('Every control token must appear exactly once')
    chip_meta = expanded['controls']['shared']['chip']['$extensions']['app.caelos']
    badge_meta = expanded['controls']['shared']['badge']['$extensions']['app.caelos']
    reference_map = lambda data: {key: ingredient(value[1:-1]) for key,value in data.items()}
    compact_controls = dict(chipGeometry=reference_map(chip_meta['construction']), chipShapes=reference_map(chip_meta['shapeRadii']), chipPaints={state:reference_map(paint) for state,paint in chip_meta['statePaints'].items()}, badgeGeometry=reference_map(badge_meta['construction']), badgeMaterial=reference_map(badge_meta['basePaint']), badgeShapes=reference_map(badge_meta['shapeRadii']), badgeTones=reference_map(badge_meta['tonePaints']))
    parameter_uses = {}
    for family in ['button', 'chip', 'badge']:
        meta = source['controls']['shared'][family]['$extensions']['app.caelos']
        for field in ['construction', 'shapeRadii']:
            for slot, choice in meta.get(field, {}).items():
                parameter_uses.setdefault(choice, []).append(family.title() + ' · ' + slot)
        category = categories[{'button':'buttons','chip':'chips','badge':'badges'}[family]]
        selection = ', '.join(slot + ' ' + choice.split('/')[-1] for slot, choice in meta['construction'].items() if not slot.startswith('type-'))
        typography = ', '.join(slot.removeprefix('type-') + ' ' + choice.split('/')[-1] for slot, choice in meta['construction'].items() if slot.startswith('type-'))
        for study in category['studies']:
            study['note'] += ('\nOpen requirements · ' + meta['openRequirements']) if 'openRequirements' in meta else ''
            study['note'] += '\nShared control construction · ' + typography + '. ' + selection
            study['sharedConstruction'] = True
            study['sharedConstructionPaths'] = [v[1:-1] for v in expanded['controls']['shared'][family]['$extensions']['app.caelos']['construction'].values()]
    for group, choices in shared['parameters'].items():
        items = []
        for choice, reference in choices.items():
            path = reference[1:-1]; own = ingredient(path); value, chain = resolve(path, 'dark'); meta = tables['dark'][path]['$extensions']['app.caelos']
            items.append(dict(**own, label=choice, status=meta['status'], evidence=meta.get('decision', meta.get('evidence', ', '.join(meta.get('decisions', [])) or 'Existing lower-tier token; shared selection consolidation approved by Daniel')), uses=parameter_uses[group + '/' + choice], chain=chain, description='Shared choice · ' + group + '/' + choice, css=None, construction=own))
        categories['shared-controls']['rows'].append(dict(name=group.replace('-', ' ').title(), items=items, countUnit='choices'))
    categories['badges']['pending'].append(dict(path='controls.shared.badge.useCases.delivery-status',name='Delivery status badge',status='partial',description=badge_meta['useCases']['delivery-status']['description'],variants={},states=[],note=badge_meta['useCases']['delivery-status']['note'],recipe=None))
    return dict(sharedConstruction=shared, compatibilityExports=compatibility_exports, compactControls=compact_controls,tier=2,pageId='377:6179',categories=list(categories.values()),tokenCount=len(covered),constructionTokens=construction_tokens, buttonStatePaints={style: {state: {key: ingredient(value[1:-1]) for key,value in paint.items()} for state,paint in states.items()} for style,states in expanded['controls']['shared']['button']['$extensions']['app.caelos']['statePaints'].items()})

if __name__=='__main__': print(json.dumps(manifest(),separators=(',',':')))
