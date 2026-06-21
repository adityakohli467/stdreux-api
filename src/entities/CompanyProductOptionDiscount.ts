import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm"
import { Company } from "./Company"
import { Product } from "./Product"
import { OptionValue } from "./OptionValue"

@Entity("company_product_option_discount")
@Index(["company_id"])
@Index(["product_id"])
@Index(["option_value_id"])
@Index(["company_id", "product_id", "option_value_id"], { unique: true })
export class CompanyProductOptionDiscount {
  @PrimaryGeneratedColumn()
  company_product_option_discount_id!: number

  @Column({ type: "int" })
  company_id!: number

  @Column({ type: "int" })
  product_id!: number

  @Column({ type: "int" })
  option_value_id!: number

  @Column({ type: "decimal", precision: 5, scale: 2 })
  discount_percentage!: number

  @CreateDateColumn({ name: "created_at" })
  created_at!: Date

  @UpdateDateColumn({ name: "updated_at" })
  updated_at!: Date

  // Relations
  @ManyToOne(() => Company)
  @JoinColumn({ name: "company_id" })
  company!: Company

  @ManyToOne(() => Product)
  @JoinColumn({ name: "product_id" })
  product!: Product

  @ManyToOne(() => OptionValue)
  @JoinColumn({ name: "option_value_id" })
  option_value!: OptionValue
}
