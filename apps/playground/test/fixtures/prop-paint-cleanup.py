"""Synthetic fixture: no coplanar intersections to clean. Production uses its owning mesh-cleanup helper."""
def clean_coplanar(mesh):
    return {'scope':'nonoverlapping synthetic test surfaces','removed':0}
