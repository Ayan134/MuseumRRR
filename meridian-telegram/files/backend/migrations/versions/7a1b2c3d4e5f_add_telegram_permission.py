"""add telegram permission (раздел «Telegram» — Telegram Web K во вкладке Meridian)

Новый корневой ключ `telegram` (routers/telegram.py, frontend/src/routes/_auth/telegram.tsx).
is_public=false: admin/owner получают его автоматически (весь каталог), остальным —
выдаётся в админке (пользователю или через дефолты роли/линии). Сделать раздел видимым
всем — `UPDATE feature_permissions SET is_public = true WHERE key = 'telegram'`.

Revision ID: 7a1b2c3d4e5f
Revises: 0e1f2a3b4c5d
Create Date: 2026-10-01 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '7a1b2c3d4e5f'
down_revision: Union[str, Sequence[str], None] = '0e1f2a3b4c5d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
        INSERT INTO feature_permissions (key, parent_key, name, is_public, "order") VALUES
            ('telegram', NULL, 'Telegram', false, 18)
        ON CONFLICT (key) DO NOTHING
    """)


def downgrade() -> None:
    op.execute("DELETE FROM role_default_permissions WHERE permission_key = 'telegram'")
    op.execute("DELETE FROM line_default_permissions WHERE permission_key = 'telegram'")
    op.execute("DELETE FROM feature_permissions WHERE key = 'telegram'")
