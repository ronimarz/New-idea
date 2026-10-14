"""Keyword profiles used to score how much of a job's duties are AV work.

Each term is (regex, weight, tag). Regexes are case-insensitive unless the
term is in CASE_SENSITIVE, which matters for the bare acronym "AV": it must
not match "av" inside ordinary words or lowercase noise.

Two profiles ship by default:
  * "audiovisual"  - audio-visual / AV technician, integration, events, conferencing
  * "autonomous"   - autonomous vehicles (in case "AV" means self-driving for you)
"""

AUDIOVISUAL = {
    "search_terms": [
        "audio visual", "audiovisual", "AV technician", "AV integration",
        "Crestron", "Extron", "video conferencing", "live sound",
    ],
    "terms": [
        # Core "this is an AV job" signals
        (r"\baudio[\s-]?visual\b", 5, "Core AV"),
        (r"\bA/V\b", 5, "Core AV"),
        (r"\bAV\b(?![-\s]?(?:club|test))", 4, "Core AV"),
        (r"\bAV(?:/IT| systems?| equipment| tech(?:nician)?s?| support| integration| integrator)\b", 4, "Core AV"),
        (r"\bAVIXA\b|\bInfoComm\b", 4, "Certification"),
        (r"\bCTS(?:-[DI])?\b", 3, "Certification"),
        # Control / DSP platforms
        (r"\bCrestron\b", 4, "Control & DSP"),
        (r"\bExtron\b", 4, "Control & DSP"),
        (r"\bAMX\b", 3, "Control & DSP"),
        (r"\bQ-?SYS\b", 4, "Control & DSP"),
        (r"\bBiamp\b|\bTesira\b", 4, "Control & DSP"),
        (r"\bDante\b", 3, "Control & DSP"),
        (r"\bShure\b|\bSennheiser\b", 2, "Control & DSP"),
        (r"\b(?:DSP|digital signal processor)s?\b", 2, "Control & DSP"),
        (r"\bcontrol (?:system )?programming\b", 3, "Control & DSP"),
        # Conferencing / workplace AV
        (r"\bvideo[\s-]?conferenc\w*", 3, "Conferencing"),
        (r"\b(?:Zoom|Teams|Webex) Rooms?\b", 3, "Conferencing"),
        (r"\b(?:conference|meeting|board) ?rooms?\b", 1, "Conferencing"),
        (r"\bPoly(?:com)?\b|\bLogitech Rally\b|\bNeat (?:Bar|Board)\b", 2, "Conferencing"),
        # Install / integration work
        (r"\bsignal flow\b", 3, "Installation"),
        (r"\brack (?:build|wiring|elevations?)\b|\bbuild racks?\b", 3, "Installation"),
        (r"\b(?:low[\s-]?voltage|structured cabling)\b", 2, "Installation"),
        (r"\b(?:HDMI|HDBaseT|SDI)\b", 2, "Installation"),
        (r"\b(?:projectors?|projection)\b", 2, "Installation"),
        (r"\b(?:display|LED) walls?\b|\bvideo walls?\b", 3, "Installation"),
        (r"\bspeakers?\b|\bamplifiers?\b", 1, "Installation"),
        (r"\b(?:system|systems) commissioning\b|\bcommissioning\b", 1, "Installation"),
        # Live events / production
        (r"\blive (?:sound|events?|production)\b", 3, "Live events"),
        (r"\b(?:mixing|audio) (?:console|board|desk)s?\b|\bFOH\b|\bfront of house\b", 3, "Live events"),
        (r"\bA1\b|\bA2\b|\bV1\b", 2, "Live events"),
        (r"\b(?:stage|event) (?:lighting|production)\b|\blighting (?:design|console)\b", 2, "Live events"),
        (r"\bmicrophones?\b|\bwireless mics?\b", 2, "Live events"),
        (r"\bsound (?:engineer|reinforcement|check)\b", 3, "Live events"),
        # Broadcast / streaming / media
        (r"\bbroadcast\w*\b", 2, "Broadcast & streaming"),
        (r"\blive[\s-]?stream\w*\b|\bwebcast\w*\b", 3, "Broadcast & streaming"),
        (r"\b(?:camera|video) (?:operat\w+|switch\w*)\b|\bvideo switcher\b", 3, "Broadcast & streaming"),
        (r"\b(?:OBS|vMix|ATEM|Tricaster)\b", 3, "Broadcast & streaming"),
        (r"\bPTZ cameras?\b", 3, "Broadcast & streaming"),
        # Support / ops
        (r"\b(?:troubleshoot\w*|repair\w*|maintain\w*) (?:audio|video|AV|A/V)\b", 3, "Support & maintenance"),
        (r"\b(?:audio|video) (?:equipment|systems?|technician|engineer)s?\b", 3, "Support & maintenance"),
        (r"\bevent support\b|\bclassroom technology\b|\bsmart classrooms?\b", 3, "Support & maintenance"),
    ],
    # Phrases that mean "AV" is something else entirely. Each hit subtracts.
    "negative": [
        (r"\banti[\s-]?virus\b|\bAV/EDR\b|\bEDR\b", 4),
        (r"\bautonomous vehicles?\b|\bself[\s-]?driving\b", 4),
        (r"\barteriovenous\b|\batrioventricular\b", 6),
    ],
}

AUTONOMOUS = {
    "search_terms": [
        "autonomous vehicle", "self-driving", "ADAS", "robotaxi", "vehicle autonomy",
    ],
    "terms": [
        (r"\bautonomous (?:vehicles?|driving|trucks?|systems?)\b", 5, "Core AV"),
        (r"\bself[\s-]?driving\b", 5, "Core AV"),
        (r"\bAVs?\b", 3, "Core AV"),
        (r"\bADAS\b", 4, "Core AV"),
        (r"\brobotaxis?\b", 4, "Core AV"),
        (r"\bperception\b", 3, "Perception"),
        (r"\b(?:lidar|LiDAR|radar)\b", 3, "Perception"),
        (r"\bsensor fusion\b", 4, "Perception"),
        (r"\b(?:motion )?planning\b", 2, "Planning & controls"),
        (r"\b(?:localization|SLAM)\b", 3, "Planning & controls"),
        (r"\bvehicle (?:dynamics|controls?)\b", 3, "Planning & controls"),
        (r"\bROS2?\b", 3, "Software"),
        (r"\bsimulation\b|\bCARLA\b", 2, "Software"),
        (r"\bsafety (?:driver|operator)s?\b|\bvehicle operator\b", 4, "Field operations"),
        (r"\b(?:ISO ?26262|SOTIF|functional safety)\b", 3, "Safety"),
    ],
    "negative": [
        (r"\baudio[\s-]?visual\b|\bA/V\b", 4),
        (r"\banti[\s-]?virus\b", 4),
    ],
}

PROFILES = {"audiovisual": AUDIOVISUAL, "autonomous": AUTONOMOUS}

# Terms whose regex must be applied without re.IGNORECASE.
CASE_SENSITIVE = {
    r"\bAV\b(?![-\s]?(?:club|test))",
    r"\bA/V\b",
    r"\bAMX\b",
    r"\bCTS(?:-[DI])?\b",
    r"\bA1\b|\bA2\b|\bV1\b",
    r"\bFOH\b|\bfront of house\b",
    r"\bAVs?\b",
    r"\bADAS\b",
    r"\bROS2?\b",
    r"\bAV/EDR\b|\bEDR\b",
    r"\b(?:OBS|vMix|ATEM|Tricaster)\b",
    r"\b(?:HDMI|HDBaseT|SDI)\b",
    r"\bAVIXA\b|\bInfoComm\b",
}
