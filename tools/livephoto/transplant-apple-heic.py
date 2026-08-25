#!/usr/bin/env python3
"""Keep an Apple camera HEIC container and replace only its primary HEVC tiles.

The donor's thumbnail, gain map, tone map, Exif/XMP and item-reference graph stay
byte-for-byte intact. Replacement tile payloads are appended in a second mdat;
only their iloc offsets/lengths and the primary hvcC property are patched.
"""

from __future__ import annotations

import argparse
import struct
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Extent:
    offset: int
    length: int
    offset_pos: int
    length_pos: int
    offset_size: int
    length_size: int
    base: int
    method: int


def boxes(data: bytes, start: int, end: int):
    pos = start
    while pos + 8 <= end:
        size = int.from_bytes(data[pos : pos + 4], "big")
        kind = data[pos + 4 : pos + 8]
        header = 8
        if size == 1:
            if pos + 16 > end:
                raise ValueError("truncated extended-size box")
            size = int.from_bytes(data[pos + 8 : pos + 16], "big")
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            raise ValueError(f"invalid {kind!r} box at {pos:#x}")
        yield pos, size, kind, header
        pos += size


def child(data: bytes, parent_kind: bytes, wanted: bytes):
    for pos, size, kind, header in boxes(data, 0, len(data)):
        if kind != parent_kind:
            continue
        start = pos + header + (4 if kind == b"meta" else 0)
        for item in boxes(data, start, pos + size):
            if item[2] == wanted:
                return item
    raise ValueError(f"{wanted.decode()} not found in {parent_kind.decode()}")


def iloc_extents(data: bytes) -> dict[int, list[Extent]]:
    pos, size, _, header = child(data, b"meta", b"iloc")
    cur = pos + header
    version = data[cur]
    cur += 4
    sizes1, sizes2 = data[cur], data[cur + 1]
    cur += 2
    offset_size, length_size = sizes1 >> 4, sizes1 & 0x0F
    base_size, index_size = sizes2 >> 4, sizes2 & 0x0F
    count_size = 4 if version == 2 else 2
    item_count = int.from_bytes(data[cur : cur + count_size], "big")
    cur += count_size
    result: dict[int, list[Extent]] = {}
    try:
        idat_pos, _, _, idat_header = child(data, b"meta", b"idat")
        idat_start = idat_pos + idat_header
    except ValueError:
        idat_start = 0
    for _ in range(item_count):
        id_size = 4 if version == 2 else 2
        item_id = int.from_bytes(data[cur : cur + id_size], "big")
        cur += id_size
        method = 0
        if version in (1, 2):
            method = int.from_bytes(data[cur : cur + 2], "big") & 0x0FFF
            cur += 2
        if method not in (0, 1):
            raise ValueError(f"unsupported iloc construction method {method}")
        cur += 2  # data_reference_index
        base = int.from_bytes(data[cur : cur + base_size], "big") if base_size else 0
        cur += base_size
        extent_count = int.from_bytes(data[cur : cur + 2], "big")
        cur += 2
        found: list[Extent] = []
        for _ in range(extent_count):
            if version in (1, 2) and index_size:
                cur += index_size
            offset_pos = cur
            relative = int.from_bytes(data[cur : cur + offset_size], "big") if offset_size else 0
            cur += offset_size
            length_pos = cur
            length = int.from_bytes(data[cur : cur + length_size], "big") if length_size else 0
            cur += length_size
            absolute = base + relative + (idat_start if method == 1 else 0)
            found.append(Extent(absolute, length, offset_pos, length_pos,
                                offset_size, length_size, base, method))
        result[item_id] = found
    if cur > pos + size:
        raise ValueError("iloc parser overran box")
    return result


def ipco_properties(data: bytes):
    iprp_pos, iprp_size, _, iprp_header = child(data, b"meta", b"iprp")
    for pos, size, kind, header in boxes(data, iprp_pos + iprp_header, iprp_pos + iprp_size):
        if kind == b"ipco":
            return list(boxes(data, pos + header, pos + size))
    raise ValueError("ipco not found")


def hvc_property(data: bytes, index: int):
    props = ipco_properties(data)
    if index < 1 or index > len(props):
        raise ValueError(f"property {index} not found")
    item = props[index - 1]
    if item[2] != b"hvcC":
        raise ValueError(f"property {index} is {item[2]!r}, not hvcC")
    return item


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("donor", type=Path)
    ap.add_argument("replacement", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--tiles", type=int, default=45)
    ap.add_argument("--donor-hvcc", type=int, default=16)
    ap.add_argument("--replacement-hvcc", type=int, default=7)
    args = ap.parse_args()

    donor = bytearray(args.donor.read_bytes())
    replacement = args.replacement.read_bytes()
    donor_items = iloc_extents(donor)
    replacement_items = iloc_extents(replacement)

    donor_h = hvc_property(donor, args.donor_hvcc)
    source_h = hvc_property(replacement, args.replacement_hvcc)
    if donor_h[1] != source_h[1]:
        raise ValueError(f"hvcC size mismatch: donor {donor_h[1]}, replacement {source_h[1]}")
    donor[donor_h[0] : donor_h[0] + donor_h[1]] = replacement[source_h[0] : source_h[0] + source_h[1]]

    payload = bytearray()
    new_positions: dict[int, tuple[int, int]] = {}
    payload_start = len(donor) + 8
    for item_id in range(1, args.tiles + 1):
        src = replacement_items.get(item_id)
        dst = donor_items.get(item_id)
        if not src or len(src) != 1 or not dst or len(dst) != 1:
            raise ValueError(f"item {item_id} must have exactly one extent")
        source_extent = src[0]
        chunk = replacement[source_extent.offset : source_extent.offset + source_extent.length]
        if len(chunk) != source_extent.length:
            raise ValueError(f"replacement item {item_id} is truncated")
        new_positions[item_id] = (payload_start + len(payload), len(chunk))
        payload.extend(chunk)

    for item_id, (offset, length) in new_positions.items():
        extent = donor_items[item_id][0]
        if extent.method != 0:
            raise ValueError(f"donor tile {item_id} is not file-offset based")
        stored_offset = offset - extent.base
        if stored_offset < 0 or stored_offset >= 1 << (8 * extent.offset_size) or length >= 1 << (8 * extent.length_size):
            raise ValueError(f"item {item_id} does not fit iloc field widths")
        donor[extent.offset_pos : extent.offset_pos + extent.offset_size] = stored_offset.to_bytes(extent.offset_size, "big")
        donor[extent.length_pos : extent.length_pos + extent.length_size] = length.to_bytes(extent.length_size, "big")

    mdat_size = len(payload) + 8
    if mdat_size >= 1 << 32:
        raise ValueError("appended mdat is too large")
    args.output.write_bytes(donor + struct.pack(">I4s", mdat_size, b"mdat") + payload)
    print(f"wrote {args.output}: {args.tiles} tiles, {len(payload)} replacement bytes")


if __name__ == "__main__":
    main()
